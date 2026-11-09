import { describe, expect, test } from "bun:test";
import { MAX_LINK_REQUEST_CHARS, MAX_REQUEST_CHARS, parseSongRequest } from "../src/music/request.ts";

describe("parseSongRequest", () => {
  test("the whole message is the song name (no prefix / wake word needed)", () => {
    expect(parseSongRequest("Annie ของ Wave to Earth")).toBe("Annie ของ Wave to Earth");
    expect(parseSongRequest("เพลงฮิต 2024")).toBe("เพลงฮิต 2024");
  });

  test("trims and collapses whitespace / newlines", () => {
    expect(parseSongRequest("  lofi   hip hop \n radio  ")).toBe("lofi hip hop radio");
  });

  test("empty / whitespace-only (attachment or sticker only) is ignored", () => {
    expect(parseSongRequest("")).toBeNull();
    expect(parseSongRequest("   \n\t ")).toBeNull();
  });

  test("too long to be a song name is ignored", () => {
    expect(parseSongRequest("x".repeat(MAX_REQUEST_CHARS))).not.toBeNull();
    expect(parseSongRequest("x".repeat(MAX_REQUEST_CHARS + 1))).toBeNull();
  });

  test("a YouTube link becomes the canonical URL", () => {
    const want = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(parseSongRequest("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(want);
    expect(parseSongRequest("  เปิดอันนี้ <https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx> ")).toBe(want);
  });

  test("a long link is not cut off by the song-name length limit", () => {
    const long = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL${"x".repeat(200)}`;
    expect(long.length).toBeGreaterThan(MAX_REQUEST_CHARS);
    expect(parseSongRequest(long)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(parseSongRequest(`${long} ${"y".repeat(MAX_LINK_REQUEST_CHARS)}`)).toBeNull();
  });

  test("a playlist link becomes the canonical playlist URL", () => {
    const list = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";
    const want = `https://www.youtube.com/playlist?list=${list}`;
    expect(parseSongRequest(`https://www.youtube.com/playlist?list=${list}&si=abc`)).toBe(want);
    expect(parseSongRequest(`เพลย์ลิสต์ <https://music.youtube.com/playlist?list=${list}>`)).toBe(want);
  });

  test("video link inside a playlist stays a single video", () => {
    const link = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=2";
    expect(parseSongRequest(link)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
