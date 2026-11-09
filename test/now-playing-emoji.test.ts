import { describe, expect, test } from "bun:test";
import { NOW_PLAYING_EMOJI, buildPlayerSections } from "../src/music/queue.ts";

const t = (title: string, lengthMs = 185_000) => ({ title, lengthMs });

describe("player panel heading", () => {
  test("the playing song's title has the emoji in front of it", () => {
    const [head] = buildPlayerSections(t("Annie"), []);
    expect(head).toBe(`## ${NOW_PLAYING_EMOJI} Annie`);
    expect(NOW_PLAYING_EMOJI).toBe("<:4767voiceevent:1569242043107115118>");
  });

  test("the emoji is only on the playing song, not on the idle panel or the queue lines", () => {
    const idle = buildPlayerSections(null, [t("Next")]).join("\n");
    expect(idle.includes(NOW_PLAYING_EMOJI)).toBe(false);
    const playing = buildPlayerSections(t("Now"), [t("Next")]).join("\n");
    expect(playing.split(NOW_PLAYING_EMOJI).length - 1).toBe(1);
  });

  test("a long title is still clipped, markdown is still escaped", () => {
    const [head] = buildPlayerSections(t("y".repeat(300)), []);
    expect(head!.length).toBeLessThan(140);
    const [esc] = buildPlayerSections(t("a_b*c"), []);
    expect(esc!.startsWith(`## ${NOW_PLAYING_EMOJI} `)).toBe(true);
    expect(esc!.includes("a_b*c")).toBe(false); // escaped
  });
});
