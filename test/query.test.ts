import { describe, expect, test } from "bun:test";
import {
  extractYouTubePlaylistUrl,
  extractYouTubeUrl,
  filterPlayable,
  parseMusicQuery,
  pickCandidate,
} from "../src/music/query.ts";

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

describe("extractYouTubeUrl", () => {
  const id = "dQw4w9WgXcQ";
  const want = `https://www.youtube.com/watch?v=${id}`;

  test("every common link shape → the same canonical URL", () => {
    for (const link of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `youtu.be/${id}`,
      `www.youtube.com/watch?v=${id}`,
      `<https://youtu.be/${id}>`,
    ]) {
      expect(extractYouTubeUrl(link)).toBe(want);
    }
  });

  test("tracking params, timestamps and playlist ids are dropped", () => {
    expect(extractYouTubeUrl(`https://youtu.be/${id}?si=AbC123&t=42`)).toBe(want);
    expect(extractYouTubeUrl(`https://www.youtube.com/watch?v=${id}&list=PLxyz&index=3`)).toBe(want);
    expect(extractYouTubeUrl(`https://www.youtube.com/watch?feature=share&v=${id}`)).toBe(want);
  });

  test("link inside a sentence (Thai or English)", () => {
    expect(extractYouTubeUrl(`เปิดเพลงนี้หน่อย https://youtu.be/${id} ขอบคุณ`)).toBe(want);
    expect(extractYouTubeUrl(`play https://youtu.be/${id}`)).toBe(want);
  });

  test("not a video link → null", () => {
    expect(extractYouTubeUrl("Shape of You")).toBeNull();
    expect(extractYouTubeUrl("https://www.youtube.com/playlist?list=PLxyz")).toBeNull();
    expect(extractYouTubeUrl("https://www.youtube.com/@somechannel")).toBeNull();
    expect(extractYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubeUrl("notyoutu.be/dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubeUrl("https://youtu.be/tooshort")).toBeNull();
  });
});

describe("parseMusicQuery with a YouTube link", () => {
  test("loaded directly: no artist split, no search text", () => {
    const q = parseMusicQuery("https://youtu.be/dQw4w9WgXcQ?si=abc");
    expect(q.directUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(q.artist).toBeNull();
    expect(q.searches).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  });

  test("plain text has no directUrl", () => {
    expect(parseMusicQuery("Lemon").directUrl).toBeNull();
  });

  test("a direct link plays the first playable result as-is", () => {
    const q = parseMusicQuery("https://youtu.be/dQw4w9WgXcQ");
    const track = t("whatever the title is");
    expect(pickCandidate([track], q, 1_200_000)).toBe(track);
  });
});

describe("extractYouTubePlaylistUrl", () => {
  const list = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";
  const want = `https://www.youtube.com/playlist?list=${list}`;

  test("playlist links → canonical playlist URL", () => {
    for (const link of [
      `https://www.youtube.com/playlist?list=${list}`,
      `https://youtube.com/playlist?list=${list}&si=AbC123`,
      `https://m.youtube.com/playlist?list=${list}`,
      `https://music.youtube.com/playlist?list=${list}`,
      `youtube.com/playlist?si=AbC123&list=${list}`,
      `https://www.youtube.com/watch?list=${list}`,
      `<https://www.youtube.com/playlist?list=${list}>`,
      `เปิดเพลย์ลิสต์นี้ https://www.youtube.com/playlist?list=${list} หน่อย`,
    ]) {
      expect(extractYouTubePlaylistUrl(link)).toBe(want);
    }
  });

  test("not a playlist link → null", () => {
    expect(extractYouTubePlaylistUrl("Shape of You")).toBeNull();
    expect(extractYouTubePlaylistUrl("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubePlaylistUrl(`https://example.com/playlist?list=${list}`)).toBeNull();
    expect(extractYouTubePlaylistUrl("https://www.youtube.com/playlist?list=short")).toBeNull();
  });

  test("a video link with &list= is still a single video", () => {
    const link = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${list}&index=2`;
    // the video extractor claims it first (parseMusicQuery / parseSongRequest check it first)
    expect(extractYouTubeUrl(link)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const q = parseMusicQuery(link);
    expect(q.directUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(q.playlistUrl).toBeNull();
  });
});

describe("parseMusicQuery with a playlist link", () => {
  test("playlistUrl set, no direct video, no search text", () => {
    const list = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";
    const q = parseMusicQuery(`https://www.youtube.com/playlist?list=${list}&si=x`);
    expect(q.playlistUrl).toBe(`https://www.youtube.com/playlist?list=${list}`);
    expect(q.directUrl).toBeNull();
    expect(q.artist).toBeNull();
    expect(q.searches).toEqual([`https://www.youtube.com/playlist?list=${list}`]);
  });

  test("plain text has no playlistUrl", () => {
    expect(parseMusicQuery("Lemon").playlistUrl).toBeNull();
  });
});

describe("filterPlayable", () => {
  test("drops streams and too-long songs, keeps order", () => {
    const a = t("a");
    const live = t("live", "", 100, true);
    const long = t("long", "", 99_999_999);
    const b = t("b");
    expect(filterPlayable([a, live, long, b], 1_200_000)).toEqual([a, b]);
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
