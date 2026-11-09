import { afterEach, describe, expect, test } from "bun:test";

const { sttConfigError, sttSummary } = await import("../src/stt/index.ts");

const KEYS = ["GROQ_API_KEY", "GROQ_STT_MODEL", "GROQ_STT_LANGUAGE"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setEnv(k: (typeof KEYS)[number], v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe("sttConfigError", () => {
  test("needs GROQ_API_KEY", () => {
    setEnv("GROQ_API_KEY", undefined);
    expect(sttConfigError()).toContain("GROQ_API_KEY");
    setEnv("GROQ_API_KEY", "k");
    expect(sttConfigError()).toBeNull();
  });
});

describe("sttSummary", () => {
  test("shows model and language, with defaults", () => {
    setEnv("GROQ_STT_MODEL", undefined);
    setEnv("GROQ_STT_LANGUAGE", undefined);
    expect(sttSummary()).toBe("groq (whisper-large-v3, lang=th)");
  });
});
