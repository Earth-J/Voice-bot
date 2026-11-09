import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SetupStore } from "../src/setup-store.ts";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-store-"));
  dirs.push(dir);
  return path.join(dir, "nested", "setup.json"); // nested: the folder must be created on save
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("SetupStore", () => {
  test("set → get, and it is saved to disk (creating the folder)", () => {
    const file = tmpFile();
    const store = new SetupStore(file);
    store.set("g1", { channelId: "c1" });
    expect(store.get("g1")).toEqual({ channelId: "c1" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ g1: { channelId: "c1" } });
  });

  test("survives a restart (new instance + load), including the embed message id", () => {
    const file = tmpFile();
    const a = new SetupStore(file);
    a.set("g1", { channelId: "c1", messageId: "m1" });
    a.set("g2", { channelId: "c2" });

    const b = new SetupStore(file);
    b.load();
    expect(b.get("g1")).toEqual({ channelId: "c1", messageId: "m1" });
    expect(b.get("g2")).toEqual({ channelId: "c2" });
    expect(b.guildIds().sort()).toEqual(["g1", "g2"]);
  });

  test("set replaces the whole entry (moving the room drops the old message id)", () => {
    const store = new SetupStore(tmpFile());
    store.set("g1", { channelId: "c1", messageId: "m1" });
    store.set("g1", { channelId: "c2" });
    expect(store.get("g1")).toEqual({ channelId: "c2" });
  });

  test("delete removes it from memory and disk", () => {
    const file = tmpFile();
    const store = new SetupStore(file);
    store.set("g1", { channelId: "c1" });
    store.delete("g1");
    expect(store.get("g1")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  test("guildForChannel finds the guild that owns a setup channel", () => {
    const store = new SetupStore(tmpFile());
    store.set("g1", { channelId: "c1" });
    store.set("g2", { channelId: "c2" });
    expect(store.guildForChannel("c2")).toBe("g2");
    expect(store.guildForChannel("nope")).toBeNull();
  });

  test("a missing file means nothing set up", () => {
    const store = new SetupStore(tmpFile());
    store.load();
    expect(store.guildIds()).toEqual([]);
  });

  test("a corrupt or odd file is ignored instead of crashing", () => {
    const file = tmpFile();
    new SetupStore(file).set("tmp", { channelId: "x" }); // creates the folder
    writeFileSync(file, "{not json");
    const bad = new SetupStore(file);
    bad.load();
    expect(bad.guildIds()).toEqual([]);

    writeFileSync(file, JSON.stringify({ g1: { channelId: "c1" }, g2: { nope: 1 }, g3: null, g4: "x" }));
    const odd = new SetupStore(file);
    odd.load();
    expect(odd.guildIds()).toEqual(["g1"]);
  });
});
