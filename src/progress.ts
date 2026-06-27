/**
 * Builds a human-readable, Persian-language progress message with a visual bar.
 * Used for both the Telegram->server download stage and every server->host upload stage.
 */
export function formatProgress(
  title: string,
  emoji: string,
  uploaded: number,
  total: number,
  speedBps: number
): string {
  const safeTotal = total > 0 ? total : 1;
  const percent = Math.max(0, Math.min(100, Math.round((uploaded / safeTotal) * 100)));
  const filled = Math.round(percent / 5);
  const bar = "▓".repeat(filled) + "░".repeat(20 - filled);

  const uploadedMB = (uploaded / (1024 * 1024)).toFixed(1);
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  const speedMBps = (speedBps / (1024 * 1024)).toFixed(1);

  const remainingBytes = Math.max(0, total - uploaded);
  const remainingSecs = speedBps > 0.001 ? remainingBytes / speedBps : 0;
  const timeStr =
    speedBps > 0.001
      ? remainingSecs > 60
        ? `${Math.round(remainingSecs / 60)} دقیقه`
        : `${Math.max(1, Math.round(remainingSecs))} ثانیه`
      : "محاسبه...";

  return (
    `${emoji} ${title}\n\n` +
    `[${bar}] ${percent}%\n` +
    `📊 ${uploadedMB} / ${totalMB} MB\n` +
    `⚡ سرعت: ${speedBps > 0.001 ? `${speedMBps} MB/s` : "محاسبه..."}\n` +
    `⏱ زمان باقیمانده: ${speedBps > 0.001 ? `~${timeStr}` : timeStr}`
  );
}

export function formatInitialProgress(title: string, emoji: string, totalBytes: number): string {
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
  return (
    `${emoji} ${title}\n\n` +
    `[░░░░░░░░░░░░░░░░░░░░] 0%\n` +
    `📊 0.0 / ${totalMB} MB\n` +
    `⚡ سرعت: محاسبه...\n` +
    `⏱ زمان باقیمانده: محاسبه...`
  );
}

/** Simple rate limiter so we don't hammer the Telegram editMessageText API. */
export function makeThrottledProgress(
  intervalMs: number,
  fn: (uploaded: number, total: number, speedBps: number) => void
): (uploaded: number, total: number, speedBps: number) => void {
  let lastUpdate = 0;
  let sentFinal = false;
  return (uploaded, total, speedBps) => {
    const now = Date.now();
    const isFinal = total > 0 && uploaded >= total;

    if (isFinal) {
      if (sentFinal) return; // only report 100% once
      sentFinal = true;
    } else if (now - lastUpdate < intervalMs) {
      return; // throttle intermediate updates
    }

    lastUpdate = now;
    fn(uploaded, total, speedBps);
  };
}
