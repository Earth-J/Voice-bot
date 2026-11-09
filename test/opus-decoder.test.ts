import { describe, expect, test } from "bun:test";
import { createOpusDecoder, isWasmTrap, type OpusBackend } from "../src/opus-decoder.ts";

function fakeBackend() {
  const stats = { created: 0, deleted: 0 };
  const backend: OpusBackend = {
    name: "fake",
    create() {
      stats.created++;
      return {
        decode: (p: Buffer) => Buffer.concat([p, p]),
        delete: () => {
          stats.deleted++;
        },
      };
    },
  };
  return { backend, stats };
}

describe("createOpusDecoder", () => {
  test("creates exactly one backend instance and decodes many packets with it", () => {
    const { backend, stats } = fakeBackend();
    const d = createOpusDecoder(backend);
    for (let i = 0; i < 100; i++) expect(d.decode(Buffer.from([i]))).toEqual(Buffer.from([i, i]));
    expect(stats.created).toBe(1);
  });

  test("destroy frees once, even if called twice", () => {
    const { backend, stats } = fakeBackend();
    const d = createOpusDecoder(backend);
    d.destroy();
    d.destroy();
    expect(stats.deleted).toBe(1);
  });

  test("decode after destroy throws a plain JS error and never touches the backend", () => {
    const { backend } = fakeBackend();
    const d = createOpusDecoder(backend);
    d.destroy();
    expect(() => d.decode(Buffer.from([1]))).toThrow("already destroyed");
  });

  test("a throwing delete() is swallowed and not retried", () => {
    let deletes = 0;
    const d = createOpusDecoder({
      name: "bad-delete",
      create: () => ({
        decode: (p) => p,
        delete: () => {
          deletes++;
          throw new Error("boom");
        },
      }),
    });
    d.destroy();
    d.destroy();
    expect(deletes).toBe(1);
  });
});

describe("isWasmTrap", () => {
  test("recognises JSC and V8 wording", () => {
    expect(isWasmTrap(new Error("Out of bounds memory access (evaluating 'invoker(fn)')"))).toBe(true);
    expect(isWasmTrap(new Error("memory access out of bounds"))).toBe(true);
  });
  test("ignores ordinary errors", () => {
    expect(isWasmTrap(new Error("Decode error: invalid packet"))).toBe(false);
  });
});
