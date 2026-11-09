/**
 * Per-session STT usage report.
 *
 * Only audio seconds + request counts are tracked. If you want a rough cost
 * estimate in the report, set GROQ_STT_USD_PER_HOUR (see Groq's pricing page)
 * and the report will show audio-seconds x that rate.
 */

export interface UsageMetrics {
  sttCallCount: number;
  sttFailedCount: number;
  /** Sum of captured audio length sent to STT, in seconds. */
  sttAudioSec: number;
}

export function emptyUsage(): UsageMetrics {
  return { sttCallCount: 0, sttFailedCount: 0, sttAudioSec: 0 };
}

export function formatUsage(m: UsageMetrics): string {
  const label = `groq: ${process.env.GROQ_STT_MODEL || "whisper-large-v3"}`;
  const lines = [
    `STT: ${Math.round(m.sttAudioSec)}s audio, ${m.sttCallCount} calls` +
      (m.sttFailedCount > 0 ? ` (${m.sttFailedCount} failed)` : "") +
      ` [${label}]`,
  ];
  const rate = Number(process.env.GROQ_STT_USD_PER_HOUR);
  if (Number.isFinite(rate) && rate > 0) {
    const usd = (m.sttAudioSec / 3600) * rate;
    lines.push(`≈ $${usd.toFixed(4)} (at $${rate}/hour, estimate)`);
  }
  return lines.join("\n");
}
