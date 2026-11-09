/**
 * Opus decoder stress test — no Discord, no real voices needed.
 *
 *   bun scripts/opus-stress.ts            # all scenarios, 3000 "utterances" each
 *   bun scripts/opus-stress.ts 10000      # heavier
 *
 * Run it under BUN (the crash message is JavaScriptCore's) and ideally on Linux
 * (Railway shell, or `docker run` the same image). It uses `opusscript` directly,
 * so it exercises the same WASM backend Railway falls back to, even on a Mac
 * where @discordjs/opus would normally win.
 *
 * Every scenario runs in its OWN process: once the WASM heap is corrupted the
 * module is dead for the rest of that process (that is why Railway needs a
 * restart), so scenarios must not share one.
 *
 *   old-leak     new decoder per utterance, never freed   (stream destroyed without 'end')
 *   old-churn    new decoder per utterance, freed after   (the well-behaved version of the old code)
 *   pooled       3 long-lived decoders reused             (the patch)
 *   bad-packets  random / truncated junk into one decoder (do garbage packets poison the heap?)
 *   live-2       2 decoders alive at the same time, used interleaved, then freed (x rounds)
 *   live-3       same with 3 decoders
 *   staggered-3  decoders created one after another while the earlier ones keep being used
 *                (what happens when users start speaking at different times)
 *   pipeline     real startSpeakerCapture + fake Discord receiver, 3 users (needs ffmpeg-static)
 *
 * Options (env vars):
 *   BACKEND=native   use @discordjs/opus instead of opusscript (compare WASM vs native)
 *
 * Also try the SAME script under Node:
 *   Node >= 22.18:   node scripts/opus-stress.ts
 *   Node 22.6-22.17: node --experimental-strip-types scripts/opus-stress.ts
 *   any Node:        npx tsx scripts/opus-stress.ts
 * If Node passes what Bun fails, the problem is Bun's WebAssembly, not your code.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { unlink } from "node:fs/promises";
import { isWasmTrap } from "../src/opus-decoder.ts";

const require = createRequire(import.meta.url);
const RATE = 48_000;
const CH = 2;
const FRAME = 960; // 20 ms
const PACKETS_PER_UTTERANCE = 30; // 0.6 s of audio

const SCENARIOS = ["old-leak", "old-churn", "pooled", "live-2", "live-3", "staggered-3", "bad-packets", "pipeline"] as const;

function newOpusScript(): any {
  const OpusScript = require("opusscript");
  return new OpusScript(RATE, CH, OpusScript.Application.AUDIO);
}

/** Decoder under test: opusscript (WASM) by default, @discordjs/opus (native) with BACKEND=native. */
function newOpus(): any {
  if (process.env.BACKEND !== "native") return newOpusScript();
  const { OpusEncoder } = require("@discordjs/opus");
  const e = new OpusEncoder(RATE, CH);
  return { decode: (b: Buffer) => e.decode(b), delete() {} };
}

/** Real opus packets: a 440 Hz tone, 20 ms each, encoded by opusscript itself. */
function makePackets(count: number): Buffer[] {
  const enc = newOpusScript();
  const pcm = Buffer.alloc(FRAME * CH * 2);
  const out: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    for (let s = 0; s < FRAME; s++) {
      const v = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (i * FRAME + s)) / RATE));
      pcm.writeInt16LE(v, s * 4);
      pcm.writeInt16LE(v, s * 4 + 2);
    }
    out.push(Buffer.from(enc.encode(pcm, FRAME))); // Buffer.from(Buffer) copies out of WASM memory
  }
  enc.delete();
  return out;
}

async function child(name: string, n: number): Promise<void> {
  const packets = makePackets(PACKETS_PER_UTTERANCE);
  let done = 0;
  let phase = "setup"; // which call was running when it failed: construct / decode / delete
  const emit = (r: object) => console.log("RESULT " + JSON.stringify({ ...r, done, phase, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  try {
    if (name === "old-leak" || name === "old-churn") {
      for (; done < n; done++) {
        phase = "construct";
        const d = newOpus();
        phase = "decode";
        for (const p of packets) d.decode(p);
        phase = "delete";
        if (name === "old-churn") d.delete();
      }
    } else if (name === "pooled") {
      phase = "construct";
      const ds = [newOpus(), newOpus(), newOpus()];
      for (; done < n; done++) {
        phase = "decode";
        const d = ds[done % 3];
        for (const p of packets) d.decode(p);
      }
      phase = "delete";
      ds.forEach((d) => d.delete());
    } else if (name === "live-2" || name === "live-3") {
      const k = name === "live-2" ? 2 : 3;
      for (; done < n; done++) {
        phase = "construct";
        const ds = Array.from({ length: k }, () => newOpus());
        phase = "decode";
        for (const p of packets) for (const d of ds) d.decode(p); // interleaved packet by packet
        phase = "delete";
        ds.forEach((d) => d.delete());
      }
    } else if (name === "staggered-3") {
      for (; done < n; done++) {
        const ds: any[] = [];
        for (let i = 0; i < 3; i++) {
          phase = "construct";
          ds.push(newOpus()); // a new "speaker" joins while the others are still being decoded
          phase = "decode";
          for (const p of packets) for (const d of ds) d.decode(p);
        }
        phase = "delete";
        ds.forEach((d) => d.delete());
      }
    } else if (name === "bad-packets") {
      phase = "construct";
      const d = newOpus();
      for (; done < n; done++) {
        phase = "decode(junk)";
        try {
          d.decode(randomBytes(1 + (done % 400)));
        } catch (e) {
          if (isWasmTrap(e)) throw e; // a JS-level "invalid packet" error is fine; a trap is not
        }
        phase = "decode(valid)";
        if (done % 10 === 0) d.decode(packets[done % packets.length]!); // must still decode afterwards
      }
      phase = "delete"; // <- if it fails HERE (done == total), the junk silently corrupted the heap
      d.delete();
    } else if (name === "pipeline") {
      const { startSpeakerCapture } = await import("../src/audio-pipeline.ts");
      const { createOpusDecoder } = await import("../src/opus-decoder.ts");
      const users = ["u1", "u2", "u3"];
      const decoders = new Map(users.map((u) => [u, createOpusDecoder()]));
      const cfg = { silenceThresholdMs: 1500, chunkFlushMs: 8000, minFinalChunkMs: 0, leadingSilenceMs: 0, minVoicedMs: 0, voicedFrameRms: 300 };
      let chunks = 0;
      let completes = 0;
      const total = Math.min(n, 90); // each one spawns ffmpeg
      for (; done < total; done++) {
        const u = users[done % 3]!;
        await new Promise<void>((resolve) => {
          const conn: any = { receiver: { subscribe: () => Readable.from(packets) } };
          startSpeakerCapture(
            conn, u, cfg,
            async (c) => { chunks++; await unlink(c.wavPath).catch(() => {}); },
            () => { completes++; resolve(); },
            decoders.get(u)!,
          );
        });
      }
      for (let i = 0; i < 100 && chunks < total; i++) await new Promise((r) => setTimeout(r, 100));
      decoders.forEach((d) => d.destroy());
      if (completes !== total || chunks !== total) {
        throw new Error(`pipeline plumbing: utterances=${total} completes=${completes} chunks=${chunks}`);
      }
    }
    emit({ ok: true });
  } catch (e: any) {
    emit({ ok: false, error: String(e?.message ?? e).slice(0, 160) });
  }
}

function parent(n: number): void {
  console.log(`runtime: ${process.versions.bun ? "bun " + process.versions.bun : "node " + process.version} on ${process.platform}/${process.arch}`);
  console.log(`backend: ${process.env.BACKEND === "native" ? "@discordjs/opus (native)" : "opusscript (WASM)"}`);
  console.log(`utterances per scenario: ${n} (x${PACKETS_PER_UTTERANCE} packets)\n`);
  let anyFail = false;
  for (const name of SCENARIOS) {
    // process.execArgv carries the TypeScript loader (tsx --import ..., --experimental-strip-types);
    // without it the child is plain node and cannot load a .ts file.
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, "--child", name, String(n)], { encoding: "utf8", timeout: 10 * 60_000 });
    const line = r.stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
    const res = line ? JSON.parse(line.slice(7)) : { ok: false, done: "?", error: ((r.stderr || r.stdout || "no result (crashed/timeout)").trim().split("\n").filter(Boolean).slice(-3).join(" | ")).slice(0, 300) };
    if (!res.ok) anyFail = true;
    console.log(`${res.ok ? "PASS" : "FAIL"}  ${name.padEnd(12)} ${String(res.done).padStart(6)} done  rss=${res.rssMB ?? "?"}MB${res.ok ? "" : `\n      → failed during: ${res.phase ?? "?"}\n      → ${res.error}`}`);
  }
  console.log(anyFail ? "\nSome scenarios failed — read the table in the instructions." : "\nAll scenarios passed.");
}

const argv = process.argv.slice(2);
if (argv[0] === "--child") await child(argv[1]!, Number(argv[2]) || 3000);
else parent(Number(argv[0]) || 3000);
