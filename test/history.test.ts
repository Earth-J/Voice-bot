import { describe, expect, test } from "bun:test";
import { MusicHistory, queryKey } from "../src/music/history.ts";
import { parseMusicQuery } from "../src/music/query.ts";

const G = "guild-1";
const annie = {
  identifier: "AAAAAAAAAAA",
  title: "wave to earth - annie (Official Audio)",
  author: "wave to earth",
  lengthMs: 200_000,
  sourceName: "youtube",
};
const other = {
  identifier: "BBBBBBBBBBB",
  title: "wave to earth - bluesky (live)",
  author: "wave to earth",
  lengthMs: 210_000,
  sourceName: "youtube",
};
const req = (text: string) => parseMusicQuery(text);

describe("MusicHistory", () => {
  test("same request again → the video played last time (exact)", () => {
    const h = new MusicHistory(":memory:");
    const q = req("Annie ของ Web2Earth");
    h.recordPlay(G, { ...annie, queryKey: queryKey(q) });
    const m = h.lookup(G, req("annie ของ wave to earth"));
    expect(m?.how).toBe("exact");
    expect(m?.track.videoId).toBe("AAAAAAAAAAA");
  });

  test("a different server does not see it", () => {
    const h = new MusicHistory(":memory:");
    h.recordPlay(G, { ...annie, queryKey: queryKey(req("Annie ของ wave to earth")) });
    expect(h.lookup("guild-2", req("Annie ของ wave to earth"))).toBeNull();
  });

  test("fuzzy: song + artist found in a played title, even if asked differently", () => {
    const h = new MusicHistory(":memory:");
    h.recordPlay(G, { ...annie, queryKey: queryKey(req("เปิด annie")) });
    const m = h.lookup(G, req("annie ของ wave to earth"));
    expect(m?.how).toBe("fuzzy");
    expect(m?.track.videoId).toBe("AAAAAAAAAAA");
  });

  test("fuzzy needs the artist too: right song name, wrong artist → no match", () => {
    const h = new MusicHistory(":memory:");
    h.recordPlay(G, annie);
    expect(h.lookup(G, req("annie ของ someone else"))).toBeNull();
  });

  test("no artist: a short name is too vague, a specific one that matches one song is fine", () => {
    const h = new MusicHistory(":memory:");
    h.recordPlay(G, annie);
    expect(h.lookup(G, req("annie"))).toBeNull(); // too short to trust
    h.recordPlay(G, { ...other, title: "Kenshi Yonezu - Lemon", author: "Kenshi Yonezu", identifier: "CCCCCCCCCCC" });
    expect(h.lookup(G, req("lemon"))).toBeNull(); // 5 letters, still too short
    h.recordPlay(G, { ...other, title: "Sunflower - Post Malone", author: "Post Malone", identifier: "DDDDDDDDDDD" });
    expect(h.lookup(G, req("sunflower"))?.track.videoId).toBe("DDDDDDDDDDD");
  });

  test("no artist and two played titles match → ambiguous → null", () => {
    const h = new MusicHistory(":memory:");
    h.recordPlay(G, { ...annie, title: "Sunflower - Post Malone", identifier: "DDDDDDDDDDD" });
    h.recordPlay(G, { ...annie, title: "Sunflower (cover)", identifier: "EEEEEEEEEEE" });
    expect(h.lookup(G, req("sunflower"))).toBeNull();
  });

  test("the video picked most often for a request wins", () => {
    const h = new MusicHistory(":memory:");
    const key = queryKey(req("annie ของ wave to earth"));
    h.recordPlay(G, { ...other, queryKey: key });
    h.recordPlay(G, { ...annie, queryKey: key });
    h.recordPlay(G, { ...annie, queryKey: key });
    expect(h.lookup(G, req("annie ของ wave to earth"))?.track.videoId).toBe("AAAAAAAAAAA");
  });

  test("skipped within seconds → rejected, not suggested again", () => {
    const h = new MusicHistory(":memory:");
    const key = queryKey(req("annie ของ wave to earth"));
    h.recordPlay(G, { ...annie, queryKey: key });
    h.reject(G, key, "AAAAAAAAAAA");
    expect(h.lookup(G, req("annie ของ wave to earth"))).toBeNull();
    // ...but if it gets picked and played again, it is trusted again
    h.recordPlay(G, { ...annie, queryKey: key });
    expect(h.lookup(G, req("annie ของ wave to earth"))?.track.videoId).toBe("AAAAAAAAAAA");
  });

  test("links, livestreams, non-YouTube sources and too-long videos are not used", () => {
    const h = new MusicHistory(":memory:");
    h.recordPlay(G, { ...annie, isStream: true });
    h.recordPlay(G, { ...annie, sourceName: "soundcloud" });
    h.recordPlay(G, { ...annie, identifier: "short" });
    expect(h.recent(G)).toHaveLength(0);

    h.recordPlay(G, { ...annie, queryKey: queryKey(req("annie ของ wave to earth")) });
    expect(h.lookup(G, req("https://youtu.be/AAAAAAAAAAA"))).toBeNull();
    expect(h.lookup(G, req("annie ของ wave to earth"), 100_000)).toBeNull(); // 200s > 100s limit
  });

  test("recent() lists plays newest first with who asked", () => {
    const h = new MusicHistory(":memory:");
    h.recordPlay(G, { ...annie, requestedBy: "u1" }, 1000);
    h.recordPlay(G, { ...other, requestedBy: "u2" }, 2000);
    const r = h.recent(G);
    expect(r.map((x) => x.videoId)).toEqual(["BBBBBBBBBBB", "AAAAAAAAAAA"]);
    expect(r[0]?.requestedBy).toBe("u2");
  });
});
