import { describe, expect, test } from "bun:test";
import { SlidingWindowLimiter, SttQueueTimeoutError } from "../src/stt/rate-limit.ts";

/** A limiter on a fake clock: "sleeping" just moves time forward. */
function fake(max: number, windowMs = 60_000) {
  const clock = { t: 0 };
  const slept: number[] = [];
  const limiter = new SlidingWindowLimiter({
    maxPerWindow: max,
    windowMs,
    now: () => clock.t,
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
    },
  });
  return { limiter, clock, slept };
}

describe("SlidingWindowLimiter", () => {
  test("requests under the limit go out immediately", async () => {
    const { limiter, clock, slept } = fake(3);
    for (let i = 0; i < 3; i++) await limiter.acquire(1_000);
    expect(slept).toEqual([]);
    expect(clock.t).toBe(0);
  });

  test("the request over the limit waits until the oldest one leaves the window", async () => {
    const { limiter, clock } = fake(2);
    await limiter.acquire(Infinity); // t = 0
    clock.t = 10_000;
    await limiter.acquire(Infinity); // t = 10s
    await limiter.acquire(Infinity); // must wait for the t = 0 stamp to expire
    expect(clock.t).toBe(60_000);
  });

  test("never lets more than `max` requests into any window", async () => {
    const { limiter, clock } = fake(5);
    const grants: number[] = [];
    for (let i = 0; i < 23; i++) {
      await limiter.acquire(Infinity);
      grants.push(clock.t);
    }
    for (const g of grants) {
      const inWindow = grants.filter((x) => x <= g && g - x < 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(5);
    }
  });

  test("serves waiters in arrival order", async () => {
    const { limiter } = fake(1, 1_000);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((i) => limiter.acquire(Infinity).then(() => order.push(i))),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("drops a request that would wait longer than maxWaitMs, without sleeping for it", async () => {
    const { limiter, clock } = fake(1);
    await limiter.acquire(1_000);
    await expect(limiter.acquire(1_000)).rejects.toBeInstanceOf(SttQueueTimeoutError);
    expect(clock.t).toBe(0);
  });

  test("a dropped request does not block the ones behind it", async () => {
    const { limiter, clock } = fake(1);
    await limiter.acquire(Infinity);
    const second = limiter.acquire(500);
    const third = limiter.acquire(Infinity);
    await expect(second).rejects.toBeInstanceOf(SttQueueTimeoutError);
    await third;
    expect(clock.t).toBe(60_000);
  });

  test("a request that went stale while queued behind others is dropped even if a slot is free", async () => {
    const { limiter, clock } = fake(5);
    const p = limiter.acquire(1_000);
    clock.t = 5_000; // it "sat in the queue" for 5s before its turn came
    await expect(p).rejects.toBeInstanceOf(SttQueueTimeoutError);
  });

  test("pause() makes everybody wait, and the timeout says why", async () => {
    const { limiter, clock } = fake(10);
    limiter.pause(5_000, "HTTP 429 on m (RPM)");
    await limiter.acquire(10_000);
    expect(clock.t).toBe(5_000);

    limiter.pause(60_000, "HTTP 429 on m (RPD)");
    const err = await limiter.acquire(10_000).catch((e) => e);
    expect(err).toBeInstanceOf(SttQueueTimeoutError);
    expect(String(err.message)).toContain("RPD");
  });

  test("a longer pause is never shortened", async () => {
    const { limiter, clock } = fake(10);
    limiter.pause(10_000);
    limiter.pause(1_000);
    await limiter.acquire(Infinity);
    expect(clock.t).toBe(10_000);
  });

  test("estimateWaitMs reflects the window and the queue", async () => {
    const { limiter, clock } = fake(2);
    expect(limiter.estimateWaitMs()).toBe(0);
    await limiter.acquire(Infinity); // stamps = [0]
    expect(limiter.estimateWaitMs()).toBe(0); // one slot still free

    const queued = limiter.acquire(Infinity); // will take the last free slot
    expect(limiter.estimateWaitMs()).toBe(60_000); // a new request is behind it
    await queued;

    expect(limiter.estimateWaitMs()).toBe(60_000); // full: oldest stamp (t=0) expires at 60s
    clock.t = 20_000;
    expect(limiter.estimateWaitMs()).toBe(40_000);
  });

  test("Infinity means no limit", async () => {
    const { limiter, slept } = fake(Infinity);
    for (let i = 0; i < 200; i++) await limiter.acquire(1);
    expect(slept).toEqual([]);
  });
});
