import { Bot } from "grammy";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as https from "https";

dotenv.config();

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_API_URL = "http://localhost:8081",
  LOCAL_FILES_DIR = "/tmp/telegram-bot-api",
  PIXELDRAIN_API_KEY
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TELEGRAM_BOT_TOKEN, {
  client: { apiRoot: TELEGRAM_BOT_API_URL }
});

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

type ProgressCallback = (uploadedBytes: number, totalBytes: number, speedBps: number) => void;

function formatProgress(uploaded: number, total: number, speedBps: number): string {
  const percent = Math.min(100, Math.round((uploaded / total) * 100));
  const filled = Math.round(percent / 5);
  const bar = "▓".repeat(filled) + "░".repeat(20 - filled);

  const uploadedMB = (uploaded / (1024 * 1024)).toFixed(1);
  const totalMB   = (total   / (1024 * 1024)).toFixed(1);
  const speedMBps = (speedBps / (1024 * 1024)).toFixed(1);

  const remainingSecs = speedBps > 0 ? (total - uploaded) / speedBps : 0;
  const timeStr = remainingSecs > 60
    ? `${Math.round(remainingSecs / 60)} دقیقه`
    : `${Math.round(remainingSecs)} ثانیه`;

  return (
    `📤 در حال آپلود به پیکسل‌درین...\n\n` +
    `[${bar}] ${percent}%\n` +
    `📊 ${uploadedMB} / ${totalMB} MB\n` +
    `⚡ سرعت: ${speedMBps} MB/s\n` +
    `⏱ زمان باقیمانده: ~${timeStr}`
  );
}

function uploadToPixeldrain(
  filePath: string,
  fileName: string,
  totalBytes: number,
  onProgress?: ProgressCallback
): Promise<string> {
  return new Promise((resolve, reject) => {
    const encodedFileName = encodeURIComponent(fileName);
    const parsedUrl = new URL(`https://pixeldrain.com/api/file/${encodedFileName}`);

    const headers: Record<string, string> = {
      "User-Agent": "telegram-uploader-bot/1.0",
      "Content-Length": totalBytes.toString()
    };

    if (PIXELDRAIN_API_KEY) {
      const auth = Buffer.from(`:${PIXELDRAIN_API_KEY}`).toString("base64");
      headers["Authorization"] = `Basic ${auth}`;
    }

    const options: https.RequestOptions = {
      method: "PUT",
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      headers
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if ((res.statusCode === 200 || res.statusCode === 201) && parsed.id) {
            resolve(`https://pixeldrain.com/u/${parsed.id}`);
          } else {
            reject(new Error(parsed.message || `آپلود ناموفق بود: ${body}`));
          }
        } catch (err: any) {
          reject(new Error(`خطا در پردازش پاسخ پیکسل‌درین: ${err.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));

    // ── Progress tracking ──────────────────────────────────────────────────
    let uploadedBytes = 0;
    const startTime = Date.now();

    const fileStream = fs.createReadStream(filePath);

    fileStream.on("data", (chunk) => {
      uploadedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as string);
      if (onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speedBps = elapsed > 0.1 ? uploadedBytes / elapsed : 0;
        onProgress(uploadedBytes, totalBytes, speedBps);
      }
    });

    fileStream.on("error", (err) => { req.destroy(); reject(err); });
    fileStream.pipe(req);
  });
}

// ── /start ────────────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  await ctx.reply(
    "سلام! فایل، ویدیو یا عکسی که میخوای رو برام بفرست تا مستقیم توی پیکسل‌درین آپلود کنم و لینک دانلود بدم.\n" +
    "این ربات از فایل‌های تا سقف ۲ گیگابایت پشتیبانی می‌کنه! 🚀"
  );
});

// ── File handler ──────────────────────────────────────────────────────────
bot.on([":document", ":photo", ":video", ":audio", ":voice", ":video_note", ":animation", ":sticker"], async (ctx) => {
  const fileDetails = getFileDetails(ctx);
  if (!fileDetails) return ctx.reply("متاسفانه قادر به خواندن جزئیات فایل دریافتی نیستم.");

  const { fileId, fileName } = fileDetails;
  const statusMsg = await ctx.reply(`در حال دریافت فایل "${fileName}" از تلگرام... ⏳`);

  try {
    const fileObj = await bot.api.getFile(fileId);
    if (!fileObj.file_path) throw new Error("مسیر فایل توسط سرور تلگرام برگردانده نشد.");

    const absoluteFilePath = path.isAbsolute(fileObj.file_path)
      ? fileObj.file_path
      : path.join(LOCAL_FILES_DIR, TELEGRAM_BOT_TOKEN, fileObj.file_path);

    if (!fs.existsSync(absoluteFilePath))
      throw new Error(`فایل در مسیر مورد نظر یافت نشد: ${absoluteFilePath}`);

    const totalBytes   = fs.statSync(absoluteFilePath).size;
    const fileSizeInMB = (totalBytes / (1024 * 1024)).toFixed(2);
    const totalMB      = (totalBytes / (1024 * 1024)).toFixed(1);

    // Show initial progress bar
    await bot.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      `📤 در حال آپلود به پیکسل‌درین...\n\n[░░░░░░░░░░░░░░░░░░░░] 0%\n📊 0.0 / ${totalMB} MB\n⚡ سرعت: محاسبه...\n⏱ زمان باقیمانده: محاسبه...`
    );

    // Rate-limited progress updater (max once per 2.5 sec)
    let lastUpdate = 0;
    const publicUrl = await uploadToPixeldrain(absoluteFilePath, fileName, totalBytes, (uploaded, total, speedBps) => {
      const now = Date.now();
      if (now - lastUpdate < 2500) return;
      lastUpdate = now;
      bot.api.editMessageText(ctx.chat.id, statusMsg.message_id, formatProgress(uploaded, total, speedBps))
        .catch(() => {});
    });

    // Cleanup local file
    try { fs.unlinkSync(absoluteFilePath); } catch {}

    await bot.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      `✅ فایل با موفقیت آپلود شد!\n\n` +
      `📦 نام فایل: ${fileName}\n` +
      `💾 حجم فایل: ${fileSizeInMB} MB\n\n` +
      `🔗 لینک دانلود مستقیم:\n${publicUrl}`,
      { link_preview_options: { is_disabled: true } }
    );

  } catch (error: any) {
    console.error("Upload error:", error);
    await bot.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      `❌ خطا در انجام فرآیند آپلود:\n${error.message || error}`
    );
  }
});

bot.start();
console.log("Telegram Pixeldrain Uploader Bot Daemon started.");

