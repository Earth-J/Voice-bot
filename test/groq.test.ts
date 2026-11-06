import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env must be set before the module is imported (it reads config at load).
process.env.GROQ_API_KEY = "test-key";
process.env.GROQ_STT_RETRY_BASE_MS = "1";
const { transcribeGroq } = await import("../src/stt/groq.ts");

const dir = mkdtempSync(join(tmpdir(), "groq-test-"));
const wav = join(dir, "chunk.wav");
writeFileSync(wav, Buffer.from("RIFF....WAVEfmt "));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(responses: Response[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(calls, responses.length - 1)]!;
    calls++;
    return r.clone();
  }) as unknown as typeof fetch;
  return () => calls;
}

const ok = () =>
  new Response(JSON.stringify({ text: " สวัสดี ", language: "thai", duration: 2.5 }), {
    status: 200,
  });
const rateLimited = () =>
  new Response("rate limit", { status: 429, headers: { "retry-after": "0" } });

describe("transcribeGroq", () => {
  test("parses a successful response", async () => {
    const calls = mockFetch([ok()]);
    const r = await transcribeGroq(wav);
    expect(r).toEqual({ text: "สวัสดี", language: "thai", durationSec: 2.5 });
    expect(calls()).toBe(1);
  });

  test("retries after HTTP 429 and then succeeds", async () => {
    const calls = mockFetch([rateLimited(), ok()]);
    const r = await transcribeGroq(wav);
    expect(r.text).toBe("สวัสดี");
    expect(calls()).toBe(2);
  });

  test("gives up after 3 attempts of 429", async () => {
    const calls = mockFetch([rateLimited()]);
    await expect(transcribeGroq(wav)).rejects.toThrow("HTTP 429");
    expect(calls()).toBe(3);
  });

  test("does not retry on 401", async () => {
    const calls = mockFetch([new Response("bad key", { status: 401 })]);
    await expect(transcribeGroq(wav)).rejects.toThrow("HTTP 401");
    expect(calls()).toBe(1);
  });
});
