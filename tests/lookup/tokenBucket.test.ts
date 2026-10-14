import { TokenBucket } from '../../services/upstream/tokenBucket';
import { fakeClock } from './helpers';

describe('TokenBucket', () => {
  it('starts full and refuses once empty', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 3, windowMs: 300_000, now: clock.now });
    expect([b.tryRemove(), b.tryRemove(), b.tryRemove(), b.tryRemove()]).toEqual([true, true, true, false]);
    expect(b.available()).toBe(0);
  });

  it('refills continuously: capacity tokens per window', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 400, windowMs: 300_000, now: clock.now });
    for (let i = 0; i < 400; i++) expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(false);
    clock.advance(750); // 400 tokens / 300 s = one token per 750 ms
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(false);
  });

  it('never exceeds capacity however long it idles', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 5, windowMs: 1000, now: clock.now });
    b.tryRemove(5);
    clock.advance(10 * 60_000);
    expect(b.available()).toBe(5);
  });

  it('reports how long until a token is available', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 10, windowMs: 10_000, now: clock.now });
    b.tryRemove(10);
    expect(b.msUntilAvailable()).toBe(1000);
    clock.advance(400);
    expect(b.msUntilAvailable()).toBe(600);
  });

  it('takes nothing when it cannot satisfy the request', () => {
    const b = new TokenBucket({ capacity: 2, windowMs: 1000, now: fakeClock().now });
    expect(b.tryRemove(3)).toBe(false);
    expect(b.available()).toBe(2);
  });

  it('rejects nonsense configuration', () => {
    expect(() => new TokenBucket({ capacity: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, windowMs: 0 })).toThrow(RangeError);
  });
});
