import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agreesWithoutPrompt,
  classifyPromptEcho,
  promptCoverage,
  similarity,
} from "../src/stt/prompt-echo.ts";
import { parseVoiceCommand } from "../src/voice-command.ts";

const PROMPT = "Earth เอิร์ธ เปิดเพลง หยุดเพลง";
const LONG_PROMPT =
  "เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour เอิร์ธ เพิ่มเพลง Perfect ของ Ed Sheeran " +
  "เอิร์ธ ข้าม เอิร์ธ หยุด เอิร์ธ เงียบ เอิร์ธ ออก เอิร์ธ ลบคิว 2";

describe("classifyPromptEcho", () => {
  test("the whole prompt coming back is certain, whatever the spacing", () => {
    expect(classifyPromptEcho(PROMPT, PROMPT)).toBe("certain");
    expect(classifyPromptEcho("Earth เอิร์ธ เปิดเพลงหยุดเพลง", PROMPT)).toBe("certain");
    expect(classifyPromptEcho(LONG_PROMPT, LONG_PROMPT)).toBe("certain");
  });

  test("short real commands are never second-guessed", () => {
    for (const t of ["เอิร์ธ ข้าม", "เอิร์ธ หยุด", "earth เงียบ", "เอิร์ธ ลบคิว 2"]) {
      expect(classifyPromptEcho(t, LONG_PROMPT)).toBe("none");
    }
  });

  test("a long single command copied from the prompt is only a suspect", () => {
    expect(classifyPromptEcho("เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour", LONG_PROMPT)).toBe("suspect");
  });

  test("a normal request with a song that is not in the prompt is left alone", () => {
    expect(classifyPromptEcho("เอิร์ธ เปิดเพลง ฤดูร้อน ของ วงสามัญชน", PROMPT)).toBe("none");
    expect(classifyPromptEcho("เอิร์ธ เปิดเพลง Shape of You", LONG_PROMPT)).toBe("none");
  });

  test("a command chain copied from the prompt is a suspect (it parses as a real command)", () => {
    const chain = "เอิร์ธ ข้าม เอิร์ธ หยุด เอิร์ธ เงียบ เอิร์ธ ออก";
    expect(parseVoiceCommand(chain)).toEqual({ kind: "stop" });
    expect(classifyPromptEcho(chain, LONG_PROMPT)).toBe("suspect");
  });

  test("a very short prompt never triggers echo logic (it could be a real command)", () => {
    expect(classifyPromptEcho("เอิร์ธ เปิดเพลง", "เอิร์ธ เปิดเพลง")).toBe("none");
    expect(classifyPromptEcho("เอิร์ธ เปิดเพลง ฤดูร้อน ของ วงสามัญชน", "เอิร์ธ เปิดเพลง")).toBe("none");
    expect(classifyPromptEcho("earth skip", "Earth")).toBe("none");
  });

  test("the prompt plus a long genuine request is not called an echo", () => {
    const text = PROMPT + " เอิร์ธ เปิดเพลง ฤดูร้อน ของ วงสามัญชน ที่ฉันชอบมากๆ เลย";
    expect(classifyPromptEcho(text, PROMPT)).not.toBe("certain");
  });

  test("no prompt / no text → none", () => {
    expect(classifyPromptEcho("เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour", "")).toBe("none");
    expect(classifyPromptEcho("", PROMPT)).toBe("none");
  });

  test("regression: an echoed prompt really would have played a song", () => {
    // Why this module exists — the parser happily turns the echo into a command.
    expect(parseVoiceCommand(PROMPT)).toEqual({ kind: "play", query: "หยุดเพลง" });
    expect(classifyPromptEcho(PROMPT, PROMPT)).toBe("certain");
  });
});

describe("promptCoverage / similarity", () => {
  test("coverage ignores short coincidental overlaps", () => {
    expect(promptCoverage("เพลงนี้ดีมาก", PROMPT)).toBeLessThan(0.5);
    expect(promptCoverage(PROMPT, PROMPT)).toBe(1);
  });

  test("similarity tolerates spelling differences, rejects unrelated text", () => {
    expect(agreesWithoutPrompt("เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour", "เออร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Color")).toBe(true);
    expect(agreesWithoutPrompt("เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour", "")).toBe(false);
    expect(similarity("ขอบคุณที่รับชม", "เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour")).toBeLessThan(0.3);
  });
});

describe("transcribe(): prompt echo flow", () => {
  const realFetch = globalThis.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  const savedPrompt = process.env.GROQ_STT_PROMPT;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    if (savedPrompt === undefined) delete process.env.GROQ_STT_PROMPT;
    else process.env.GROQ_STT_PROMPT = savedPrompt;
  });

  const dir = mkdtempSync(join(tmpdir(), "echo-test-"));
  const wavFile = () => {
    const p = join(dir, `c${Math.random().toString(36).slice(2)}.wav`);
    writeFileSync(p, Buffer.from("RIFF....WAVEfmt "));
    return p;
  };

  /** Mock Groq: replies[i] is the text for call i; records whether each call carried a prompt. */
  function mockGroq(replies: string[]) {
    const sentPrompt: Array<string | null> = [];
    let n = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      const form = init.body as FormData;
      sentPrompt.push((form.get("prompt") as string | null) ?? null);
      const text = replies[Math.min(n++, replies.length - 1)]!;
      return new Response(JSON.stringify({ text, language: "thai", duration: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    return sentPrompt;
  }

  async function run(replies: string[]) {
    process.env.GROQ_API_KEY = "k";
    process.env.GROQ_STT_PROMPT = LONG_PROMPT;
    const { transcribe } = await import("../src/stt/index.ts");
    const sent = mockGroq(replies);
    const r = await transcribe(wavFile());
    return { text: r.text, sent };
  }

  test("whole-prompt echo is dropped with a single STT call", async () => {
    const { text, sent } = await run([LONG_PROMPT]);
    expect(text).toBe("");
    expect(sent).toHaveLength(1);
  });

  test("suspect echo: re-checked without the prompt; noise → dropped", async () => {
    const { text, sent } = await run(["เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour", ""]);
    expect(text).toBe("");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(LONG_PROMPT);
    expect(sent[1]).toBeNull(); // second call really carried no prompt
  });

  test("suspect echo: re-check hears the same thing → real request kept", async () => {
    const { text } = await run([
      "เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour",
      "เออร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Color",
    ]);
    expect(text).toBe("เอิร์ธ เปิดเพลง รักแรกพบ ของ Tattoo Colour");
  });

  test("short commands and ordinary requests cost exactly one STT call", async () => {
    for (const reply of ["เอิร์ธ ข้าม", "เอิร์ธ เปิดเพลง ฤดูร้อน ของ วงสามัญชน"]) {
      const { text, sent } = await run([reply]);
      expect(text).toBe(reply);
      expect(sent).toHaveLength(1);
    }
  });
});
