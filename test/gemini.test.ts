import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.GEMINI_API_KEY = "main-key";
process.env.GEMINI_API_KEY_BACKUP = "backup-key";
process.env.GEMINI_TIMEOUT_MS = "300";
const { correctSongQuery, _resetGeminiState } = await import("../src/stt/gemini.ts");

const realFetch = globalThis.fetch;
beforeEach(() => _resetGeminiState());
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answer = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
  });
const limited = () => new Response("quota", { status: 429 });

/** Mock fetch: handler gets the key that was used. Returns the list of keys used. */
function mock(handler: (key: string) => Response | Promise<Response>) {
  const used: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const key = init.headers["x-goog-api-key"] as string;
    used.push(key);
    // Like the real fetch: reject as soon as the abort signal fires.
    const aborted = new Promise<never>((_, reject) =>
      (init.signal as AbortSignal).addEventListener("abort", () =>
        reject(new DOMException("aborted", "TimeoutError")),
      ),
    );
    return Promise.race([Promise.resolve(handler(key)), aborted]);
  }) as unknown as typeof fetch;
  return used;
}

describe("correctSongQuery", () => {
  test("returns the corrected text from the main key", async () => {
    const used = mock(() => answer("Blinding Lights\n"));
    expect(await correctSongQuery("บลายดิ้ง ไลท์")).toBe("Blinding Lights");
    expect(used).toEqual(["main-key"]);
  });

  test("fails over to the backup key on 429, in the same request", async () => {
    const used = mock((k) => (k === "main-key" ? limited() : answer("Blinding Lights")));
    expect(await correctSongQuery("บลายดิ้ง ไลท์")).toBe("Blinding Lights");
    expect(used).toEqual(["main-key", "backup-key"]);
  });

  test("skips the rate-limited main key on later requests", async () => {
    mock((k) => (k === "main-key" ? limited() : answer("ก")));
    await correctSongQuery("one");
    const used = mock(() => answer("two fixed"));
    expect(await correctSongQuery("two")).toBe("two fixed");
    expect(used).toEqual(["backup-key"]);
  });

  test("returns the original text when both keys are limited", async () => {
    mock(() => limited());
    expect(await correctSongQuery("เพลงอะไรสักอย่าง")).toBe("เพลงอะไรสักอย่าง");
    // both paused now → no network call at all
    const used = mock(() => answer("x"));
    expect(await correctSongQuery("อีกเพลง")).toBe("อีกเพลง");
    expect(used).toEqual([]);
  });

  test("returns the original text on timeout", async () => {
    mock(
      (_k) =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(answer("late")), 2000)),
    );
    const t0 = Date.now();
    expect(await correctSongQuery("ช้ามาก")).toBe("ช้ามาก");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("ignores an answer that is far too long", async () => {
    mock(() => answer("Sure! Here is a very long explanation ".repeat(10)));
    expect(await correctSongQuery("สั้น")).toBe("สั้น");
  });

  test("caches repeated queries", async () => {
    const used = mock(() => answer("Fixed"));
    await correctSongQuery("same");
    await correctSongQuery("same");
    expect(used.length).toBe(1);
  });
});
