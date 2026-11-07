import { describe, expect, test } from "bun:test";
import { parseMusicQuery, pickCandidate } from "../src/music/query.ts";

const t = (title: string, author = "", length = 200_000, isStream = false) => ({
  info: { title, author, length, isStream },
});

describe("parseMusicQuery", () => {
  test("song ของ artist → artist song, with misheard artist fixed", () => {
    const q = parseMusicQuery("Annie ของ Web2Earth");
    expect(q.song).toBe("Annie");
    expect(q.artist).toBe("wave to earth");
    expect(q.searches).toEqual(["wave to earth Annie", "Annie wave to earth"]);
  });

  test("ของวง / ของศิลปิน", () => {
    expect(parseMusicQuery("Annie ของวง wave to earth").artist).toBe("wave to earth");
    expect(parseMusicQuery("Lemon ของ Kenshi Yonezu").artist).toBe("Kenshi Yonezu");
  });

  test("ของ inside a Thai title (no spaces) is left alone", () => {
    const q = parseMusicQuery("ของขวัญ");
    expect(q.artist).toBeNull();
    expect(q.searches).toEqual(["ของขวัญ"]);
    expect(parseMusicQuery("รักของฉัน").artist).toBeNull();
  });

  test("plain query unchanged", () => {
    expect(parseMusicQuery("Shape of You").searches).toEqual(["Shape of You"]);
  });
});

describe("pickCandidate", () => {
  const q = parseMusicQuery("Annie ของ Web2Earth");

  test("skips a different song by the same artist", () => {
    const love = t("wave to earth - love. (Official Lyric Video)", "wave to earth");
    const annie = t("wave to earth - annie (Official Audio)", "wave to earth");
    expect(pickCandidate([love, annie], q, 1_200_000)).toBe(annie);
  });

  test("no title with the song name → null (not the wrong song)", () => {
    const love = t("wave to earth - love.", "wave to earth");
    expect(pickCandidate([love], q, 1_200_000)).toBeNull();
  });

  test("prefers the right artist when the song name is shared", () => {
    const other = t("Annie - someone else", "Someone");
    const right = t("Annie (Official)", "wave to earth");
    expect(pickCandidate([other, right], q, 1_200_000)).toBe(right);
  });

  test("ignores streams and too-long results", () => {
    const live = t("annie live", "wave to earth", 100, true);
    const long = t("annie 3 hours", "wave to earth", 99_999_999);
    expect(pickCandidate([live, long], q, 1_200_000)).toBeNull();
  });

  test("no artist → first playable, like before", () => {
    const a = t("anything");
    expect(pickCandidate([a], parseMusicQuery("Lemon"), 1_200_000)).toBe(a);
  });
});
