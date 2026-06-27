import { Bot } from "grammy";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

import { formatProgress, formatInitialProgress, makeThrottledProgress } from "./progress";
import { pixeldrainService } from "./uploaders/pixeldrain";
import { gofileService } from "./uploaders/gofile";
import { storageToService } from "./uploaders/storageto";
import { UploaderService } from "./types";

dotenv.config();

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_API_URL = "http://localhost:8081",
  LOCAL_FILES_DIR = "/tmp/telegram-bot-api"
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TELEGRAM_BOT_TOKEN, {
  client: { apiRoot: TELEGRAM_BOT_API_URL }
});

// All upload destinations the bot will try, in order.
const services: UploaderService[] = [pixeldrainService, gofileService, storageToService];

function getFileDetails(ctx: any) {
  const message = ctx.message;
  if (!message) return null;
  if (message.document) return { fileId: message.document.file_id, fileName: message.document.file_name || `file_${Date.now()}`, mimeType: message.document.mime_type };
  if (message.photo) { const p = message.photo[message.photo.length - 1]; return { fileId: p.file_id, fileName: `photo_${p.file_id}.jpg`, mimeType: "image/jpeg" }; }
  if (message.video) return { fileId: message.video.file_id, fileName: message.video.file_name || `video_${Date.now()}.mp4`, mimeType: message.video.mime_type || "video/mp4" };
  if (message.audio) return { fileId: message.audio.file_id, fileName: message.audio.file_name || `audio_${Date.now()}.mp3`, mimeType: message.audio.mime_type || "audio/mpeg" };
  if (message.voice) return { fileId: message.voice.file_id, fileName: `voice_${message.voice.file_id}.ogg`, mimeType: message.voice.mime_type || "audio/ogg" };
  if (message.video_note) return { fileId: message.video_note.file_id, fileName: `note_${message.video_note.file_id}.mp4`, mimeType: "video/mp4" };
  if (message.animation) return { fileId: message.animation.file_id, fileName: message.animation.file_name || `gif_${Date.now()}.gif`, mimeType: message.animation.mime_type || "image/gif" };
  if (message.sticker) return { fileId: message.sticker.file_id, fileName: `sticker_${message.sticker.file_id}.webp`, mimeType: "image/webp" };
  return null;
}

/**
 * The local Telegram Bot API server starts pulling the file from Telegram's
 * servers as soon as the message arrives - it writes directly to disk at
 * LOCAL_FILES_DIR as bytes come in, growing the file in place. By the time we
 * call getFile() it may already be fully downloaded (small/medium files), or
 * still in progress (large files, slow links). Either way, polling the on-disk
 * file size gives us a real, accurate progress readout instead of a frozen
 * "در حال دریافت..." message - no need to re-download anything ourselves.
 */
function waitForLocalFileWithProgress(absoluteFilePath: string, totalBytes: number, onProgress?: (uploaded: number, total: number, speedBps: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      err ? reject(err) : resolve();
    };

    const interval = setInterval(() => {
      try {
        if (!fs.existsSync(absoluteFilePath)) return;
        const size = fs.statSync(absoluteFilePath).size;
        if (onProgress) {
          const elapsed = (Date.now() - startTime) / 1000;
          const speedBps = elapsed > 0.1 ? size / elapsed : 0;
          onProgress(size, totalBytes, speedBps);
        }
        if (size >= totalBytes) finish();
      } catch (err: any) {
        finish(err);
      }
    }, 400);

    // Safety timeout: if the file never reaches full size, don't hang forever.
    setTimeout(() => finish(), 10 * 60 * 1000);
  });
}

// ── /start ────────────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  const serviceList = services.map((s) => `${s.emoji} ${s.label}`).join("، ");
  await ctx.reply(
    "سلام! فایل، ویدیو یا عکسی که میخوای رو برام بفرست تا مستقیم توی چند هاست مختلف آپلود کنم و لینک‌های دانلود مستقیم بدم.\n\n" +
    `📡 سرویس‌های فعال: ${serviceList}\n\n` +
    "این ربات از فایل‌های تا سقف ۲ گیگابایت پشتیبانی می‌کنه! 🚀"
  );
});

// ── File handler ──────────────────────────────────────────────────────────
bot.on([":document", ":photo", ":video", ":audio", ":voice", ":video_note", ":animation", ":sticker"], async (ctx) => {
  const fileDetails = getFileDetails(ctx);
  if (!fileDetails) return ctx.reply("متاسفانه قادر به خواندن جزئیات فایل دریافتی نیستم.");

  const { fileId, fileName, mimeType } = fileDetails;
  const statusMsg = await ctx.reply(`در حال دریافت فایل "${fileName}" از تلگرام... ⏳`);

  let absoluteFilePath: string | null = null;

  try {
    const fileObj = await bot.api.getFile(fileId);
    if (!fileObj.file_path) throw new Error("مسیر فایل توسط سرور تلگرام برگردانده نشد.");

    absoluteFilePath = path.isAbsolute(fileObj.file_path)
      ? fileObj.file_path
      : path.join(LOCAL_FILES_DIR, TELEGRAM_BOT_TOKEN, fileObj.file_path);

    if (!fs.existsSync(absoluteFilePath))
      throw new Error(`فایل در مسیر مورد نظر یافت نشد: ${absoluteFilePath}`);

    const totalBytes = fs.statSync(absoluteFilePath).size;
    const fileSizeInMB = (totalBytes / (1024 * 1024)).toFixed(2);

    // ── Stage 0: show progress while Telegram finishes handing us the file ──
    // (For most cases the local Bot API server has already saved it fully by
    // the time we get here, so this resolves immediately; for very large files
    // it gives real-time feedback instead of a frozen "در حال دریافت" message.)
    await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id, formatInitialProgress("در حال دریافت از تلگرام...", "📥", totalBytes));

    const reportDownload = makeThrottledProgress(2000, (uploaded, total, speed) => {
      bot.api.editMessageText(ctx.chat.id, statusMsg.message_id, formatProgress("در حال دریافت از تلگرام...", "📥", uploaded, total, speed)).catch(() => {});
    });

    await waitForLocalFileWithProgress(absoluteFilePath, totalBytes, reportDownload);

    // ── Stage 1..N: upload to every configured destination, one at a time ──
    const results: { service: UploaderService; url?: string; error?: string }[] = [];

    for (const service of services) {
      await bot.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        formatInitialProgress(`در حال آپلود به ${service.label}...`, service.emoji, totalBytes)
      ).catch(() => {});

      const reportUpload = makeThrottledProgress(2000, (uploaded, total, speed) => {
        bot.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          formatProgress(`در حال آپلود به ${service.label}...`, service.emoji, uploaded, total, speed)
        ).catch(() => {});
      });

      try {
        const url = await service.upload(absoluteFilePath, fileName, mimeType, totalBytes, reportUpload);
        results.push({ service, url });
      } catch (error: any) {
        console.error(`Upload error [${service.label}]:`, error);
        results.push({ service, error: error?.message || String(error) });
      }
    }

    // Cleanup local file once all uploads have finished (success or failure).
    try { fs.unlinkSync(absoluteFilePath); } catch {}

    const successLines = results
      .filter((r) => r.url)
      .map((r) => `${r.service.emoji} ${r.service.label}:\n${r.url}`);
    const failureLines = results
      .filter((r) => r.error)
      .map((r) => `${r.service.emoji} ${r.service.label}: ❌ ${r.error}`);

    if (successLines.length === 0) {
      await bot.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ آپلود فایل در همه‌ی سرویس‌ها ناموفق بود:\n\n${failureLines.join("\n")}`
      );
      return;
    }

    let finalText =
      `✅ فایل با موفقیت آپلود شد!\n\n` +
      `📦 نام فایل: ${fileName}\n` +
      `💾 حجم فایل: ${fileSizeInMB} MB\n\n` +
      `🔗 لینک‌های دانلود مستقیم:\n\n` +
      successLines.join("\n\n");

    if (failureLines.length > 0) {
      finalText += `\n\n⚠️ آپلود ناموفق در:\n${failureLines.join("\n")}`;
    }

    await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id, finalText, {
      link_preview_options: { is_disabled: true }
    });
  } catch (error: any) {
    console.error("Upload error:", error);
    if (absoluteFilePath) {
      try { fs.unlinkSync(absoluteFilePath); } catch {}
    }
    await bot.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      `❌ خطا در انجام فرآیند آپلود:\n${error.message || error}`
    );
  }
});

bot.start();
console.log("Telegram Multi-Host Uploader Bot Daemon started.");
console.log(`Active services: ${services.map((s) => s.label).join(", ")}`);
