/**
 * utils/subscriptionHelper.ts keeps a user's active subscription, the subscription badge and the features of a plan in memory
 * (they sat on the path of the ebook pages, every requireFeature gate, the profile and the home dashboard, each 2-5 round trips).
 * The writers drop them: invalidateSubscriptionCache(userId) / invalidatePlanCache(). The pool is a fake that counts the statements, and
 * the caches are switched on by NODE_ENV (they read it at every call; the rest of the suite runs with them off).
 */
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...args: any[]) => mockQuery(...args) }));

import {
  computeSubscriptionBadge,
  featuresForSubscription,
  getActiveSubscription,
  getFeaturesForUser,
  invalidatePlanCache,
  invalidateSubscriptionCache,
} from '../utils/subscriptionHelper';

type World = {
  subscriptions: Record<string, { id: string; plan_id: string; plan_name: string } | undefined>;
  planFeatures: Record<string, Record<string, string>>;
  free: Record<string, string>;
};
let world: World;
let previousEnv: string | undefined;

const statements = (match: RegExp) => mockQuery.mock.calls.filter(([sql]) => match.test(String(sql))).length;

beforeEach(() => {
  previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development'; // caches on
  world = {
    subscriptions: { paid: { id: 's1', plan_id: 'plan-pro', plan_name: 'Pro' } },
    planFeatures: { 'plan-pro': { flashcard_max_decks: 'unlimited', retrieval_practice_daily: '10' } },
    free: { flashcard_max_decks: '3', retrieval_practice_daily: 'false' },
  };
  invalidateSubscriptionCache();
  invalidatePlanCache();
  mockQuery.mockReset().mockImplementation(async (sql: string, params: any[] = []) => {
    const text = String(sql);
    if (/^\s*UPDATE user_subscriptions/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM user_subscriptions us\s+JOIN subscription_plans sp ON sp.id = us.plan_id\s+WHERE us.user_id = \$1\s+AND us.status IN/.test(text)) {
      const s = world.subscriptions[params[0]];
      return { rows: s ? [{ ...s }] : [] };
    }
    if (/FROM \(SELECT id FROM subscription_plans/.test(text)) return { rows: Object.entries(world.free).map(([feature_key, feature_value]) => ({ feature_key, feature_value })) };
    if (/FROM plan_features WHERE plan_id = \$1/.test(text)) {
      return { rows: Object.entries(world.planFeatures[params[0]] ?? {}).map(([feature_key, feature_value]) => ({ feature_key, feature_value })) };
    }
    if (/SELECT sp.name\s+FROM user_subscriptions us/.test(text)) {
      const s = world.subscriptions[params[0]];
      return { rows: s ? [{ name: s.plan_name }] : [] };
    }
    throw new Error(`unexpected statement: ${text}`);
  });
});

afterEach(() => {
  process.env.NODE_ENV = previousEnv;
});

describe('getActiveSubscription', () => {
  it('reads a user once and then serves the answer from memory, "no subscription" included', async () => {
    expect(await getActiveSubscription('paid')).toMatchObject({ id: 's1', plan_name: 'Pro' });
    expect(await getActiveSubscription('paid')).toMatchObject({ id: 's1' });
    expect(await getActiveSubscription('nobody')).toBeNull();
    expect(await getActiveSubscription('nobody')).toBeNull();
    // per user: the expiry UPDATE and the SELECT together, once — 2 users → 2 + 2 statements
    expect(statements(/^\s*UPDATE user_subscriptions/)).toBe(2);
    expect(statements(/status IN \('active', 'trial'\)/)).toBe(2);
  });

  it('hands out copies, so a caller that changes the row does not change what the next one gets', async () => {
    const first = (await getActiveSubscription('paid'))!;
    first.plan_name = 'Hacked';
    expect((await getActiveSubscription('paid'))!.plan_name).toBe('Pro');
  });

  it('invalidateSubscriptionCache(userId) makes that user (only) read again — an approved payment shows at once', async () => {
    await getActiveSubscription('paid');
    await getActiveSubscription('nobody');
    mockQuery.mockClear();

    world.subscriptions.nobody = { id: 's2', plan_id: 'plan-pro', plan_name: 'Pro' }; // the admin approved a payment
    invalidateSubscriptionCache('nobody');
    expect(await getActiveSubscription('nobody')).toMatchObject({ id: 's2' });
    expect(await getActiveSubscription('paid')).toMatchObject({ id: 's1' });
    expect(statements(/status IN \('active', 'trial'\)/)).toBe(1); // only "nobody" was read again
  });

  it('invalidateSubscriptionCache() forgets everybody', async () => {
    await getActiveSubscription('paid');
    invalidateSubscriptionCache();
    mockQuery.mockClear();
    await getActiveSubscription('paid');
    expect(statements(/status IN \('active', 'trial'\)/)).toBe(1);
  });

  it('concurrent callers share one read', async () => {
    await Promise.all([getActiveSubscription('paid'), getActiveSubscription('paid'), getActiveSubscription('paid')]);
    expect(statements(/status IN \('active', 'trial'\)/)).toBe(1);
  });
});

describe('getFeaturesForUser', () => {
  it('a subscriber gets the features of the plan, read once for all subscribers of that plan', async () => {
    world.subscriptions.other = { id: 's3', plan_id: 'plan-pro', plan_name: 'Pro' };
    expect(await getFeaturesForUser('paid')).toEqual({ flashcard_max_decks: 'unlimited', retrieval_practice_daily: '10' });
    expect(await getFeaturesForUser('other')).toEqual({ flashcard_max_decks: 'unlimited', retrieval_practice_daily: '10' });
    expect(statements(/FROM plan_features WHERE plan_id = \$1/)).toBe(1);
  });

  it('a user without a subscription gets the free plan\'s features from ONE statement, read once', async () => {
    expect(await getFeaturesForUser('nobody')).toEqual({ flashcard_max_decks: '3', retrieval_practice_daily: 'false' });
    expect(await getFeaturesForUser('someone-else')).toEqual({ flashcard_max_decks: '3', retrieval_practice_daily: 'false' });
    expect(statements(/FROM \(SELECT id FROM subscription_plans/)).toBe(1);
  });

  it('an empty free plan (or none) gives {}', async () => {
    world.free = {};
    expect(await getFeaturesForUser('nobody')).toEqual({});
  });

  it('hands out copies of the feature map', async () => {
    const f = await getFeaturesForUser('paid');
    f.flashcard_max_decks = '0';
    expect((await getFeaturesForUser('paid')).flashcard_max_decks).toBe('unlimited');
  });

  it('invalidatePlanCache() makes the next call read the plans again — an admin\'s edit shows at once', async () => {
    await getFeaturesForUser('paid');
    await getFeaturesForUser('nobody');
    world.planFeatures['plan-pro'] = { flashcard_max_decks: '50' };
    world.free = { flashcard_max_decks: '5' };
    invalidatePlanCache();
    expect(await getFeaturesForUser('paid')).toEqual({ flashcard_max_decks: '50' });
    expect(await getFeaturesForUser('nobody')).toEqual({ flashcard_max_decks: '5' });
  });

  it('featuresForSubscription takes a subscription already in hand and does not look it up again', async () => {
    const sub = await getActiveSubscription('paid');
    mockQuery.mockClear();
    expect(await featuresForSubscription(sub)).toEqual({ flashcard_max_decks: 'unlimited', retrieval_practice_daily: '10' });
    expect(statements(/status IN \('active', 'trial'\)/)).toBe(0);
  });
});

describe('computeSubscriptionBadge', () => {
  it('is read once per user, FREE without a subscription, and follows invalidateSubscriptionCache', async () => {
    expect(await computeSubscriptionBadge('paid')).toBe('PRO');
    expect(await computeSubscriptionBadge('paid')).toBe('PRO');
    expect(await computeSubscriptionBadge('nobody')).toBe('FREE');
    expect(await computeSubscriptionBadge('nobody')).toBe('FREE');
    expect(statements(/SELECT sp.name/)).toBe(2);

    world.subscriptions.nobody = { id: 's2', plan_id: 'plan-pro', plan_name: 'Premium' };
    invalidateSubscriptionCache('nobody');
    expect(await computeSubscriptionBadge('nobody')).toBe('PREMIUM');
  });
});

describe('with the caches off (NODE_ENV=test)', () => {
  it('every call reads the database', async () => {
    process.env.NODE_ENV = 'test';
    await getActiveSubscription('paid');
    await getActiveSubscription('paid');
    expect(statements(/status IN \('active', 'trial'\)/)).toBe(2);
  });
});
