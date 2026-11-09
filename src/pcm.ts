/**
 * Prepend `ms` of digital silence to 16-bit little-endian PCM.
 *
 * Whisper tends to swallow or mangle the first word when a clip begins
 * abruptly (no lead-in silence) — Discord's own noise gate also clips the
 * speech onset, so almost every utterance starts "mid-phoneme". A short
 * run of leading silence gives the model a clean start.
 */
export function padLeadingSilence(
  pcm: Buffer,
  ms: number,
  rate: number,
  channels: number,
): Buffer {
  if (!Number.isFinite(ms) || ms <= 0) return pcm;
  const frames = Math.round((rate * ms) / 1000);
  const pad = Buffer.alloc(frames * channels * 2); // s16le: 2 bytes/sample, zeros = silence
  return Buffer.concat([pad, pcm]);
}

export interface PcmStats {
  /** Length of the audio actually received, in ms (NOT wall-clock: Discord sends no packets during silence). */
  audioMs: number;
  /** Total ms of 20ms frames whose high-passed RMS reached `minFrameRms`. */
  voicedMs: number;
  /** Loudest high-passed frame RMS (0-32768) — handy for tuning the threshold from logs. */
  maxFrameRms: number;
}

export interface AnalyzeOptions {
  /** A frame counts as "voiced" at or above this RMS (16-bit scale). Default 300 (≈ -41 dBFS). */
  minFrameRms?: number;
  /** High-pass corner, Hz. Wind/handling rumble sits mostly below this. Default 200. */
  highpassHz?: number;
  frameMs?: number;
}

/**
 * Cheap "is there anything speech-like in here?" measurement for 16-bit
 * little-endian PCM. Mixes down to mono, runs two cascaded one-pole high-pass
 * filters (~12 dB/octave) so low-frequency wind rumble doesn't count as
 * energy, then counts 20ms frames that are still loud enough.
 *
 * It is deliberately crude: it removes quiet / rumbly / very short noise
 * before we spend an STT call on it. Loud broadband noise still passes —
 * that is what the Whisper confidence filter in stt/groq.ts is for.
 */
export function analyzePcm(
  pcm: Buffer,
  rate: number,
  channels: number,
  opts: AnalyzeOptions = {},
): PcmStats {
  const minFrameRms = opts.minFrameRms ?? 300;
  const frameMs = opts.frameMs ?? 20;
  const fc = opts.highpassHz ?? 200;

  const totalFrames = Math.floor(pcm.length / (2 * channels));
  const audioMs = (totalFrames / rate) * 1000;
  const frameLen = Math.max(1, Math.round((rate * frameMs) / 1000));

  const rc = 1 / (2 * Math.PI * fc);
  const alpha = rc / (rc + 1 / rate);

  let x1 = 0, y1 = 0; // stage 1 state
  let x2 = 0, y2 = 0; // stage 2 state
  let sumSq = 0;
  let n = 0;
  let voicedFrames = 0;
  let maxRms = 0;

  const endFrame = () => {
    if (n === 0) return;
    const rms = Math.sqrt(sumSq / n);
    if (rms > maxRms) maxRms = rms;
    if (rms >= minFrameRms) voicedFrames++;
    sumSq = 0;
    n = 0;
  };

  for (let i = 0; i < totalFrames; i++) {
    let x = 0;
    for (let c = 0; c < channels; c++) x += pcm.readInt16LE((i * channels + c) * 2);
    x /= channels;

    const s1 = alpha * (y1 + x - x1);
    x1 = x;
    y1 = s1;
    const s2 = alpha * (y2 + s1 - x2);
    x2 = s1;
    y2 = s2;

    sumSq += s2 * s2;
    if (++n === frameLen) endFrame();
  }
  if (n >= frameLen / 2) endFrame(); // ignore a tiny trailing fragment

  return { audioMs, voicedMs: voicedFrames * frameMs, maxFrameRms: Math.round(maxRms) };
}
