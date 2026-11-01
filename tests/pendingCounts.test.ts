/**
 * The sidebar of a super admin shows two counters (approval requests and payments waiting). injectAdmin needs them on EVERY page, and
 * they were two COUNT queries in front of the page's own reads. Now: ONE statement, kept for 10 s, dropped by the code that changes them.
 */
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...args: any[]) => mockQuery(...args) }));

import { getPendingCounts, invalidatePendingCounts } from '../utils/pendingCounts';

let previousEnv: string | undefined;
let counts = { approvals: 2, transactions: 1 };

beforeEach(() => {
  previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development'; // caches on
  counts = { approvals: 2, transactions: 1 };
  invalidatePendingCounts();
  mockQuery.mockReset().mockImplementation(async () => ({ rows: [{ ...counts }] }));
});

afterEach(() => {
  process.env.NODE_ENV = previousEnv;
});

describe('getPendingCounts', () => {
  it('reads both numbers with ONE statement and then serves them from memory', async () => {
    expect(await getPendingCounts()).toEqual({ approvals: 2, transactions: 1 });
    expect(await getPendingCounts()).toEqual({ approvals: 2, transactions: 1 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('approval_requests');
    expect(sql).toContain('transactions');
  });

  it('shows a change at once when the writer calls invalidatePendingCounts()', async () => {
    await getPendingCounts();
    counts = { approvals: 3, transactions: 1 }; // a moderator asked for an approval
    invalidatePendingCounts();
    expect(await getPendingCounts()).toEqual({ approvals: 3, transactions: 1 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('every page of a burst shares one read', async () => {
    await Promise.all([getPendingCounts(), getPendingCounts(), getPendingCounts()]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('is not used under NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    await getPendingCounts();
    await getPendingCounts();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
