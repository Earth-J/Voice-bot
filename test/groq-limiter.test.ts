import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GROQ_API_KEY = "test-key";
const { transcribeGroq, parseTryAgainMs, resetRateLimiters } = await import("../src/stt/groq.ts");
const { SttQueueTimeoutError } = await import("../src/stt/rate-limit.ts");

const PRIMARY = process.env.GROQ_STT_MODEL || "whisper-large-v3";
const TURBO = "whisper-large-v3-turbo";

const dir = mkdtempSync(join(tmpdir(), "groq-limiter-test-"));
const wav = join(dir, "chunk.wav");
writeFileSync(wav, Buffer.from("RIFF....WAVEfmt "));

const ENV_KEYS = ["GROQ_STT_MAX_RPM", "GROQ_STT_MAX_QUEUE_WAIT_MS", "GROQ_STT_FALLBACK_MODEL", "GROQ_STT_FALLBACK_MAX_RPM"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetRateLimiters();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  resetRateLimiters();
});

const ok = () =>
  new Response(JSON.stringify({ text: " สวัสดี ", language: "thai", duration: 1 }), { status: 200 });
const limited = (headers: Record<string, string> = {}, body = "rate limit") =>
  new Response(body, { status: 429, headers });

/** Mock fetch; records which model each request was sent to. */
function mockFetch(handler: (model: string, n: number) => Response) {
  const models: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: FormData }) => {
    const model = String(init.body.get("model"));
    models.push(model);
    return handler(model, models.length);
  }) as unknown as typeof fetch;
  return models;
}

describe("parseTryAgainMs", () => {
  test("reads Groq's real 429 message", () => {
    const msg =
      "Rate limit reached for model `whisper-large-v3` in organization `org_x` service tier `on_demand` " +
      "on requests per minute (RPM): Limit 20, Used 20, Requested 1. Please try again in 3s. Need more tokens?";
    expect(parseTryAgainMs(msg)).toBe(3000);
  });
  test("understands ms, s, m and h parts", () => {
    expect(parseTryAgainMs("Please try again in 250ms.")).toBe(250);
    expect(parseTryAgainMs("Please try again in 2.5s.")).toBe(2500);
    expect(parseTryAgainMs("Please try again in 1m30s.")).toBe(90_000);
    expect(parseTryAgainMs("Please try again in 1h2m.")).toBe(3_720_000);
  });
  test("null when there is no hint", () => {
    expect(parseTryAgainMs("rate limit")).toBeNull();
    expect(parseTryAgainMs("")).toBeNull();
  });
});

describe("transcribeGroq + rate limiter", () => {
  test("a burst is capped at GROQ_STT_MAX_RPM; the rest is dropped instead of hammering the API", async () => {
    process.env.GROQ_STT_MAX_RPM = "2";
    process.env.GROQ_STT_MAX_QUEUE_WAIT_MS = "50";
    const models = mockFetch(() => ok());
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => transcribeGroq(wav)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(SttQueueTimeoutError);
    expect(models).toHaveLength(2); // only 2 requests ever reached the network
  });

  test("when the main model is full, chunks spill over to the fallback model", async () => {
    process.env.GROQ_STT_MAX_RPM = "2";
    process.env.GROQ_STT_FALLBACK_MODEL = TURBO;
    const models = mockFetch(() => ok());
    for (let i = 0; i < 4; i++) await transcribeGroq(wav);
    expect(models).toEqual([PRIMARY, PRIMARY, TURBO, TURBO]);
  });

  test("429 on the main model: the retry goes to the fallback straight away (no sleeping)", async () => {
    process.env.GROQ_STT_FALLBACK_MODEL = TURBO;
    const models = mockFetch((model) => (model === PRIMARY ? limited({ "retry-after": "30" }) : ok()));
    const t0 = Date.now();
    const r = await transcribeGroq(wav);
    expect(r.text).toBe("สวัสดี");
    expect(models).toEqual([PRIMARY, TURBO]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("429 with a long wait and no fallback: fails fast instead of sleeping", async () => {
    const models = mockFetch(() => limited({ "retry-after": "60" }));
    const t0 = Date.now();
    await expect(transcribeGroq(wav)).rejects.toBeInstanceOf(SttQueueTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(models).toHaveLength(1);
  });

  test("a later chunk does not hit the API while the model is paused after a 429", async () => {
    const models = mockFetch(() => limited({ "retry-after": "60" }));
    await transcribeGroq(wav).catch(() => {});
    await transcribeGroq(wav).catch(() => {});
    expect(models).toHaveLength(1); // 2nd chunk never left the building
  });

  test("honours 'try again in' from the body when there is no Retry-After header", async () => {
    const models = mockFetch((_m, n) =>
      n === 1 ? limited({}, "Rate limit reached ... Please try again in 10ms.") : ok(),
    );
    const t0 = Date.now();
    const r = await transcribeGroq(wav);
    expect(r.text).toBe("สวัสดี");
    expect(models).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150); // 10ms hint + safety margin
  });
});
