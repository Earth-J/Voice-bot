/**
 * Status sound effects played by the LISTENER bot (the one that hears voice commands).
 *
 * Put the .mp3 files in ./sounds (or SFX_DIR). They are decoded ONCE at startup with
 * ffmpeg into raw 48 kHz stereo PCM and kept in memory, so playing one is instant.
 * A missing file is simply skipped (that status stays silent).
 *
 * Env:
 *   SFX_DIR     folder with the mp3 files (default: ./sounds next to src/)
 *   SFX_VOLUME  0–2, default 1 (applied while decoding)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";

export type SfxName = "play" | "add" | "skip" | "remove" | "stop" | "notfound" | "lastsong" | "nosong";

export const SFX_FILES: Record<SfxName, string> = {
  play: "playmusic.mp3", //          เริ่มเล่นเพลง
  add: "addmusicqueue.mp3", //       เพิ่มเพลงเข้าคิว
  skip: "skipmusicqueue.mp3", //     ข้ามเพลง
  remove: "removemusicqueue.mp3", // ลบเพลงออกจากคิว
  stop: "stopmusic.mp3", //          หยุดเพลง
  notfound: "notfoundmusic.mp3", //  หาเพลงไม่เจอ / ทำไม่ได้
  lastsong: "lastsonginqueue.mp3", // กำลังเล่นเพลงสุดท้าย (ไม่มีเพลงเหลือในคิวแล้ว)
  nosong: "nosonginqueue.mp3", //     เพลงหมดแล้วทั้งคิวและเพลงปัจจุบัน
};

const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || "ffmpeg";
const DIR = process.env.SFX_DIR || fileURLToPath(new URL("../sounds/", import.meta.url));
const envVol = Number(process.env.SFX_VOLUME);
const VOLUME = process.env.SFX_VOLUME && Number.isFinite(envVol) ? Math.min(Math.max(envVol, 0), 2) : 1;
/** Safety cap: ~10 s of 48 kHz stereo s16le. Longer files are rejected to keep RAM small. */
const MAX_BYTES = 48_000 * 2 * 2 * 10;

const cache = new Map<SfxName, Buffer>();

function decode(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", path, "-vn", "-af", `volume=${VOLUME}`, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"];
    const ff = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 200)}`)),
    );
  });
}

/** Decode every sound file that exists. Never throws. */
export async function loadSfx(): Promise<void> {
  for (const [name, file] of Object.entries(SFX_FILES) as [SfxName, string][]) {
    const path = join(DIR, file);
    if (!existsSync(path)) {
      console.warn(`[sfx] missing ${file} — "${name}" will be silent (looked in ${DIR})`);
      continue;
    }
    try {
      const pcm = await decode(path);
      if (pcm.length === 0) throw new Error("decoded to 0 bytes");
      if (pcm.length > MAX_BYTES) throw new Error(`too long (${(pcm.length / 192_000).toFixed(1)}s, max 10s)`);
      cache.set(name, pcm);
      console.log(`[sfx] loaded ${file} (${(pcm.length / 192_000).toFixed(1)}s)`);
    } catch (e: any) {
      console.warn(`[sfx] could not load ${file}:`, e?.message ?? e);
    }
  }
}

export function getSfx(name: SfxName): Buffer | undefined {
  return cache.get(name);
}
