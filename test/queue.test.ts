import { describe, expect, test } from "bun:test";
import {
  TrackQueue,
  buildPlayerContent,
  buildQueueListEmbed,
  buildQueueListText,
  thumbnailFor,
} from "../src/music/queue.ts";

const t = (title: string, lengthMs = 185_000) => ({ title, lengthMs });

describe("TrackQueue", () => {
  test("push / remove by 1-based number / shift", () => {
    const q = new TrackQueue<string>(5);
    expect(q.push("a")).toBe(1);
    expect(q.push("b")).toBe(2);
    expect(q.push("c")).toBe(3);
    expect(q.remove(2)).toBe("b");
    expect(q.list()).toEqual(["a", "c"]);
    expect(q.remove(0)).toBeNull();
    expect(q.remove(3)).toBeNull();
    expect(q.remove(1.5)).toBeNull();
    expect(q.shift()).toBe("a");
    expect(q.list()).toEqual(["c"]);
  });

  test("full queue rejects, clear empties", () => {
    const q = new TrackQueue<number>(2);
    q.push(1);
    q.push(2);
    expect(q.push(3)).toBeNull();
    q.clear();
    expect(q.length).toBe(0);
  });

  test("list() is a copy", () => {
    const q = new TrackQueue<number>();
    q.push(1);
    q.list().push(99);
    expect(q.length).toBe(1);
  });
});

describe("buildQueueListEmbed (📋 popup)", () => {
  test("now playing + numbered queue", () => {
    const e = buildQueueListEmbed(t("Now"), [t("One", 60_000), t("Two")]);
    expect(e.title).toContain("คิวเพลง");
    expect(e.description).toContain("กำลังเล่น");
    expect(e.description).toContain("Now `3:05`");
    expect(e.description).toContain("`1.` One `1:00`");
    expect(e.description).toContain("`2.` Two `3:05`");
    expect(e.description).toContain("คิว** (2)");
  });

  test("empty queue / nothing playing", () => {
    const e = buildQueueListEmbed(null, []);
    expect(e.description).toContain("ไม่ได้เล่นเพลง");
    expect(e.description).toContain("ว่าง");
  });

  test("markdown in titles is escaped", () => {
    const e = buildQueueListEmbed(t("a_b*c [x]"), []);
    expect(e.description).toContain("a\\_b\\*c \\[x\\]");
  });

  test("long queues show 25 lines and stay under the 4096 limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => t(`${"x".repeat(200)} ${i}`));
    const e = buildQueueListEmbed(t("y".repeat(300)), many);
    expect(e.description.length).toBeLessThan(4096);
    expect(e.description).toContain("และอีก 25 เพลง");
  });
});

describe("buildQueueListText (Components V2 popup)", () => {
  test("is the embed's title + description as markdown", () => {
    const text = buildQueueListText(t("Now"), [t("One", 60_000)]);
    expect(text).toStartWith("### 🎵 คิวเพลง\n");
    expect(text).toContain("Now `3:05`");
    expect(text).toContain("`1.` One `1:00`");
  });
});

describe("thumbnailFor", () => {
  test("YouTube tracks only", () => {
    const yt = { ...t("Now"), uri: "https://www.youtube.com/watch?v=abc123", identifier: "abc123" };
    expect(thumbnailFor(yt)).toBe("https://i.ytimg.com/vi/abc123/hqdefault.jpg");

    const other = { ...t("Now"), uri: "https://soundcloud.com/x/y", identifier: "abc123" };
    expect(thumbnailFor(other)).toBeUndefined();
    expect(thumbnailFor(t("Now"))).toBeUndefined();
  });
});

describe("buildPlayerContent (panel text)", () => {
  test("now playing + numbered queue", () => {
    const c = buildPlayerContent(t("Now"), [t("One", 60_000), t("Two")]);
    expect(c).toContain("▶️ กำลังเล่น");
    expect(c).toContain("**Now**");
    expect(c).toContain("`1.` One `1:00`");
    expect(c).toContain("`2.` Two `3:05`");
    expect(c).toContain("คิว** (2)");
  });

  test("title links out when the track has a uri", () => {
    const c = buildPlayerContent({ ...t("Now"), uri: "https://youtu.be/abc123" }, []);
    expect(c).toContain("[**Now**](https://youtu.be/abc123)");
  });

  test("author and requester lines", () => {
    const c = buildPlayerContent({ ...t("Now"), author: "Some Artist", requestedBy: "123456" }, []);
    expect(c).toContain("โดย Some Artist");
    expect(c).toContain("ขอโดย <@123456>");
  });

  test("paused status", () => {
    expect(buildPlayerContent(t("Now"), [], { paused: true })).toContain("หยุดชั่วคราว");
    expect(buildPlayerContent(t("Now"), [])).not.toContain("หยุดชั่วคราว");
  });

  test("nothing playing → idle panel without a queue section", () => {
    const c = buildPlayerContent(null, []);
    expect(c).toContain("ไม่ได้เล่นเพลง");
    expect(c).not.toContain("📋");
  });

  test("markdown in titles is escaped", () => {
    const c = buildPlayerContent(t("a_b*c [x]"), []);
    expect(c).toContain("a\\_b\\*c \\[x\\]");
  });

  test("loop label", () => {
    expect(buildPlayerContent(t("Now"), [])).toContain("วนซ้ำ: ปิด");
    expect(buildPlayerContent(t("Now"), [], { loop: "track" })).toContain("วนซ้ำ: เพลงนี้");
    expect(buildPlayerContent(t("Now"), [], { loop: "queue" })).toContain("วนซ้ำ: ทั้งคิว");
  });

  test("volume line only when a volume is given", () => {
    expect(buildPlayerContent(t("Now"), [], { volumePct: 45 })).toContain("ระดับเสียง: 45%");
    expect(buildPlayerContent(t("Now"), [])).not.toContain("ระดับเสียง");
  });

  test("hint footer stays as a muted -# line", () => {
    const c = buildPlayerContent(null, []);
    expect(c).toContain("-# earth เพิ่มเพลง");
    expect(c).toContain("earth เงียบ");
  });

  test("music room panel tells people to type a song name", () => {
    expect(buildPlayerContent(null, [], { setupChannel: true })).toContain("พิมพ์ชื่อเพลง");
    expect(buildPlayerContent(null, [])).not.toContain("พิมพ์ชื่อเพลง");
  });

  test("maxShown option limits the queue lines", () => {
    const c = buildPlayerContent(t("Now"), [t("a"), t("b"), t("c")], { maxShown: 2 });
    expect(c).toContain("`2.` b");
    expect(c).not.toContain("`3.` c");
    expect(c).toContain("และอีก 1 เพลง");
  });

  test("default shows 5 queue lines and stays under 2000 chars", () => {
    const many = Array.from({ length: 50 }, (_, i) => t(`${"x".repeat(200)} ${i}`));
    const c = buildPlayerContent(t("y".repeat(300)), many);
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(c).toContain("`5.`");
    expect(c).not.toContain("`6.`");
    expect(c).toContain("และอีก 45 เพลง");
  });
});
