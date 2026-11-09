import { describe, expect, test } from "bun:test";
import { analyzePcm, padLeadingSilence } from "../src/pcm.ts";

describe("padLeadingSilence", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);

  test("prepends zeroed 48kHz stereo s16le silence of the right length", () => {
    const out = padLeadingSilence(pcm, 400, 48_000, 2);
    // 400ms * 48000 = 19200 frames * 2 ch * 2 bytes = 76800 bytes of padding
    expect(out.length).toBe(76_800 + pcm.length);
    expect(out.subarray(0, 76_800).every((b) => b === 0)).toBe(true);
    expect([...out.subarray(76_800)]).toEqual([1, 2, 3, 4]);
  });

  test("0 / negative / NaN leaves the audio untouched", () => {
    expect(padLeadingSilence(pcm, 0, 48_000, 2)).toBe(pcm);
    expect(padLeadingSilence(pcm, -5, 48_000, 2)).toBe(pcm);
    expect(padLeadingSilence(pcm, NaN, 48_000, 2)).toBe(pcm);
  });
});

/** 48kHz stereo s16le made of summed sines (freq Hz, amplitude), `ms` long. */
function tone(parts: Array<[number, number]>, ms: number, rate = 48_000): Buffer {
  const frames = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (const [f, a] of parts) v += a * Math.sin((2 * Math.PI * f * i) / rate);
    const s = Math.max(-32768, Math.min(32767, Math.round(v)));
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

describe("analyzePcm", () => {
  test("audioMs comes from the byte length", () => {
    expect(analyzePcm(Buffer.alloc(48_000 * 4), 48_000, 2).audioMs).toBe(1000);
  });

  test("digital silence has no voiced frames", () => {
    const r = analyzePcm(Buffer.alloc(48_000 * 4), 48_000, 2);
    expect(r.voicedMs).toBe(0);
    expect(r.maxFrameRms).toBe(0);
  });

  test("loud low-frequency rumble (wind-like, 40Hz) is not counted as voiced", () => {
    const r = analyzePcm(tone([[40, 8000]], 1000), 48_000, 2);
    expect(r.voicedMs).toBe(0);
  });

  test("speech-band energy (500Hz + 1.2kHz) is counted as voiced", () => {
    const r = analyzePcm(tone([[500, 5000], [1200, 3000]], 1000), 48_000, 2);
    expect(r.voicedMs).toBeGreaterThanOrEqual(900);
  });

  test("a short 100ms bump stays well under a 200ms gate", () => {
    const pcm = Buffer.concat([tone([[1000, 6000]], 100), Buffer.alloc(48_000 * 4)]);
    const r = analyzePcm(pcm, 48_000, 2);
    expect(r.voicedMs).toBeLessThan(200);
    expect(r.voicedMs).toBeGreaterThan(0);
  });

  test("a short real command (~350ms of speech-band audio) passes a 200ms gate", () => {
    const r = analyzePcm(tone([[600, 5000], [1500, 2500]], 350), 48_000, 2);
    expect(r.voicedMs).toBeGreaterThanOrEqual(200);
  });
});
