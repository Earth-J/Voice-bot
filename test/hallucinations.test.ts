import { describe, expect, test } from "bun:test";
import { detectRepetition, isHallucination } from "../src/stt/hallucinations.ts";

describe("hallucination filter", () => {
  test("drops known Thai outro phrases", () => {
    expect(isHallucination("ขอบคุณที่รับชม")).toBe(true);
    expect(isHallucination("ขอบคุณ ที่ รับ ชม ครับ")).toBe(true);
  });

  test("drops a standalone parenthetical", () => {
    expect(isHallucination("(เสียงหัวเราะ)")).toBe(true);
  });

  test("keeps normal speech", () => {
    expect(isHallucination("วันนี้เราจะคุยกันเรื่องงานกลุ่ม")).toBe(false);
  });

  test("empty text is not flagged", () => {
    expect(isHallucination("")).toBe(false);
    expect(isHallucination("   ")).toBe(false);
  });

  test("detects runaway repetition", () => {
    const text = Array(5).fill("ไป กิน ข้าว กัน").join(" ");
    expect(detectRepetition(text)).not.toBeNull();
    expect(isHallucination(text)).toBe(true);
  });

  test("does not flag repeated filler words", () => {
    const text = "อืม อืม อืม อืม อืม อืม อืม อืม อืม";
    expect(detectRepetition(text)).toBeNull();
  });
});
