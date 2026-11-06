import { describe, expect, test } from "bun:test";
import { TrackQueue, buildQueueEmbed } from "../src/music/queue.ts";

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

describe("buildQueueEmbed", () => {
  test("now playing + numbered queue", () => {
    const e = buildQueueEmbed(t("Now"), [t("One", 60_000), t("Two")]);
    expect(e.title).toContain("คิวเพลง");
    expect(e.description).toContain("กำลังเล่น");
    expect(e.description).toContain("Now `3:05`");
    expect(e.description).toContain("`1.` One `1:00`");
    expect(e.description).toContain("`2.` Two `3:05`");
    expect(e.description).toContain("คิว** (2)");
  });

  test("empty queue / nothing playing", () => {
    const e = buildQueueEmbed(null, []);
    expect(e.description).toContain("ไม่ได้เล่นเพลง");
    expect(e.description).toContain("ว่าง");
  });

  test("markdown in titles is escaped", () => {
    const e = buildQueueEmbed(t("a_b*c [x]"), []);
    expect(e.description).toContain("a\\_b\\*c \\[x\\]");
  });

  test("long queues are truncated and stay under the 4096 embed limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => t(`${"x".repeat(200)} ${i}`));
    const e = buildQueueEmbed(t("y".repeat(300)), many);
    expect(e.description.length).toBeLessThan(4096);
    expect(e.description).toContain("และอีก 35 เพลง");
  });
});
