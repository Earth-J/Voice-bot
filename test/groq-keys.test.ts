import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GROQ_API_KEY = "key-A";
const { transcribeGroq, groqApiKeys, resetRateLimiters } = await import("../src/stt/groq.ts");
const { SttQueueTimeoutError } = await import("../src/stt/rate-limit.ts");
const { sttConfigError, sttSummary } = await import("../src/stt/index.ts");

const dir = mkdtempSync(join(tmpdir(), "groq-keys-test-"));
const wav = join(dir, "chunk.wav");
writeFileSync(wav, Buffer.from("RIFF....WAVEfmt "));

const ENV_KEYS = [
  "GROQ_API_KEY",
  "GROQ_API_KEYS",
  "GROQ_STT_MAX_RPM",
  "GROQ_STT_MAX_QUEUE_WAIT_MS",
  "GROQ_STT_FALLBACK_MODEL",
  "GROQ_STT_MODEL",
  "GROQ_STT_LANGUAGE",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GROQ_API_KEY = "key-A";
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
const status = (code: number, headers: Record<string, string> = {}, body = "x") =>
  new Response(body, { status: code, headers });

/** Mock fetch; records which API key each request was sent with. */
function mockFetch(handler: (key: string, n: number) => Response) {
  const keys: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: { headers: Record<string, string> }) => {
    const key = String(init.headers.Authorization).replace("Bearer ", "");
    keys.push(key);
    return handler(key, keys.length);
  }) as unknown as typeof fetch;
  return keys;
}

describe("groqApiKeys", () => {
  test("GROQ_API_KEY first, then GROQ_API_KEYS; split on comma / space / newline", () => {
    process.env.GROQ_API_KEYS = "key-B, key-C\nkey-D";
    expect(groqApiKeys()).toEqual(["key-A", "key-B", "key-C", "key-D"]);
  });
  test("drops duplicates, empty items and surrounding quotes", () => {
    process.env.GROQ_API_KEYS = ' "key-A", ,\'key-B\' ,key-B';
    expect(groqApiKeys()).toEqual(["key-A", "key-B"]);
  });
  test("works with only GROQ_API_KEYS set", () => {
    delete process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEYS = "key-B,key-C";
    expect(groqApiKeys()).toEqual(["key-B", "key-C"]);
    expect(sttConfigError()).toBeNull();
  });
  test("nothing set → empty list and a config error", () => {
    delete process.env.GROQ_API_KEY;
    expect(groqApiKeys()).toEqual([]);
    expect(sttConfigError()).toContain("GROQ_API_KEY");
  });
  test("summary shows the key count only when there are several", () => {
    expect(sttSummary()).toBe("groq (whisper-large-v3, lang=th)");
    process.env.GROQ_API_KEYS = "key-B";
    expect(sttSummary()).toBe("groq (whisper-large-v3, lang=th, 2 keys)");
  });
});

describe("transcribeGroq with several keys", () => {
  test("each key has its own quota: when key A is full, chunks go to key B", async () => {
    process.env.GROQ_API_KEYS = "key-B";
    process.env.GROQ_STT_MAX_RPM = "2";
    const keys = mockFetch(() => ok());
    for (let i = 0; i < 4; i++) await transcribeGroq(wav);
    expect(keys).toEqual(["key-A", "key-A", "key-B", "key-B"]);
  });

  test("once every key is full the burst is dropped, not sent", async () => {
    process.env.GROQ_API_KEYS = "key-B";
    process.env.GROQ_STT_MAX_RPM = "1";
    process.env.GROQ_STT_MAX_QUEUE_WAIT_MS = "50";
    const keys = mockFetch(() => ok());
    const results = await Promise.allSettled([1, 2, 3].map(() => transcribeGroq(wav)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(SttQueueTimeoutError);
    expect(keys).toHaveLength(2);
  });

  test("429 on key A: the retry goes to key B straight away", async () => {
    process.env.GROQ_API_KEYS = "key-B";
    const keys = mockFetch((key) => (key === "key-A" ? status(429, { "retry-after": "30" }) : ok()));
    const t0 = Date.now();
    const r = await transcribeGroq(wav);
    expect(r.text).toBe("สวัสดี");
    expect(keys).toEqual(["key-A", "key-B"]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("key A stays paused after its 429, so the next chunk uses key B directly", async () => {
    process.env.GROQ_API_KEYS = "key-B";
    const keys = mockFetch((key) => (key === "key-A" ? status(429, { "retry-after": "30" }) : ok()));
    await transcribeGroq(wav);
    await transcribeGroq(wav);
    expect(keys).toEqual(["key-A", "key-B", "key-B"]);
  });

  test("401 on key A: it is skipped from then on and the chunk is retried on key B", async () => {
    process.env.GROQ_API_KEYS = "key-B";
    const keys = mockFetch((key) => (key === "key-A" ? status(401, {}, "invalid api key") : ok()));
    const r = await transcribeGroq(wav);
    expect(r.text).toBe("สวัสดี");
    await transcribeGroq(wav);
    expect(keys).toEqual(["key-A", "key-B", "key-B"]); // key A was only tried once
  });

  test("every key rejected → clear error, no endless loop", async () => {
    process.env.GROQ_API_KEYS = "key-B";
    const keys = mockFetch(() => status(401, {}, "invalid api key"));
    await expect(transcribeGroq(wav)).rejects.toThrow("every Groq API key was rejected");
    expect(keys).toEqual(["key-A", "key-B"]);
  });

  test("a single key that answers 401 still fails with the HTTP error (unchanged behaviour)", async () => {
    const keys = mockFetch(() => status(401, {}, "invalid api key"));
    await expect(transcribeGroq(wav)).rejects.toThrow("HTTP 401");
    expect(keys).toHaveLength(1);
  });

  test("main model on key B is preferred over the spill-over model on key A", async () => {
    process.env.GROQ_API_KEYS = "key-B";
    process.env.GROQ_STT_MAX_RPM = "1";
    process.env.GROQ_STT_FALLBACK_MODEL = "whisper-large-v3-turbo";
    const calls: string[] = [];
    globalThis.fetch = (async (_u: unknown, init: { headers: Record<string, string>; body: FormData }) => {
      calls.push(`${String(init.headers.Authorization).replace("Bearer ", "")}:${String(init.body.get("model"))}`);
      return ok();
    }) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) await transcribeGroq(wav);
    expect(calls).toEqual([
      "key-A:whisper-large-v3",
      "key-B:whisper-large-v3",
      "key-A:whisper-large-v3-turbo",
    ]);
  });
});
