/**
 * Opus decoding with a BOUNDED number of decoder instances.
 *
 * Why this exists: prism.opus.Decoder allocates a fresh opus decoder for every
 * stream. audio-pipeline used to open a new one for every utterance of every
 * user. With the opusscript (WASM) backend each instance is allocated inside a
 * single shared WASM heap and must be freed with .delete(); churning through
 * hundreds of them eventually corrupts / exhausts that heap and every later
 * `new OpusScript(...)` throws "Out of bounds memory access" — the bot then goes
 * deaf until the process restarts.
 *
 * Here each user gets ONE decoder for the lifetime of the voice session, and
 * decode() is called directly on the opus packets. The session frees them all
 * on disconnect.
 */
import { createRequire } from "node:module";

const RATE = 48_000;
const CHANNELS = 2;

export interface OpusDecoder {
  /** Decode one opus packet → 48kHz stereo s16le PCM. Throws if destroyed. */
  decode(packet: Buffer): Buffer;
  /** Free the underlying (native / WASM) decoder. Safe to call twice. */
  destroy(): void;
}

/** What a backend must provide. Injected in tests. */
export interface OpusBackend {
  name: string;
  create(): { decode(packet: Buffer): Buffer; delete?: () => void };
}

let cachedBackend: OpusBackend | null = null;

/** Same preference order as prism-media: native @discordjs/opus first, opusscript as fallback. */
function loadBackend(): OpusBackend {
  if (cachedBackend) return cachedBackend;
  const require = createRequire(import.meta.url);

  let nativeError: unknown = null;
  try {
    const mod = require("@discordjs/opus");
    const Native = mod.OpusEncoder;
    // Construct once to prove the .node binary really loads on this runtime.
    new Native(RATE, CHANNELS);
    cachedBackend = { name: "@discordjs/opus", create: () => new Native(RATE, CHANNELS) };
    console.log("[opus] decoder backend: @discordjs/opus (native)");
    return cachedBackend;
  } catch (e) {
    nativeError = e;
  }

  const why = String((nativeError as any)?.message ?? nativeError).split("\n")[0];
  // Stress tests (scripts/opus-stress.ts) showed opusscript (WASM) aborting as soon as 3 decoders
  // are alive at once under Bun, and failing after ~50 un-freed ones. With several listeners that
  // is exactly the crash this bot hit — so make the fallback loud, and optionally fatal.
  if (process.env.OPUS_REQUIRE_NATIVE === "true") {
    throw new Error(`OPUS_REQUIRE_NATIVE=true but @discordjs/opus could not be loaded: ${why}`);
  }
  console.warn(
    `[opus] ⚠️ native @discordjs/opus unavailable (${why}) — falling back to opusscript (WASM), ` +
      `which is NOT safe with 3+ simultaneous speakers. Set OPUS_REQUIRE_NATIVE=true to fail at startup instead.`,
  );

  const OpusScript = require("opusscript");
  cachedBackend = {
    name: "opusscript",
    create: () => new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO),
  };
  return cachedBackend;
}

export function createOpusDecoder(backend: OpusBackend = loadBackend()): OpusDecoder {
  let inner: ReturnType<OpusBackend["create"]> | null = backend.create();
  return {
    decode(packet: Buffer): Buffer {
      if (!inner) throw new Error("opus decoder already destroyed");
      return inner.decode(packet);
    },
    destroy(): void {
      const d = inner;
      inner = null; // null first: a throwing delete() must not allow a second delete()
      try {
        d?.delete?.();
      } catch {}
    },
  };
}

export function opusBackendName(): string {
  return loadBackend().name;
}

/**
 * Once the WASM heap is corrupted no new decoder can ever be created in this
 * process. Detect that error so callers can restart instead of staying deaf.
 */
export function isWasmTrap(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e);
  return /out of bounds memory access|memory access out of bounds|unreachable/i.test(msg);
}

// Fail at boot (clear message, visible in the deploy log) instead of silently running the WASM fallback.
if (process.env.OPUS_REQUIRE_NATIVE === "true") loadBackend();
