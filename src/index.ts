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

// Configure grammy bot to use local Telegram Bot API Server
const bot = new Bot(TELEGRAM_BOT_TOKEN, {
  client: {
    apiRoot: TELEGRAM_BOT_API_URL
  }
});

// Get target file info regardless of message type
function getFileDetails(ctx: any) {
  const message = ctx.message;
  if (!message) return null;

  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name || `file_${Date.now()}`,
      mimeType: message.document.mime_type
    };
  }
  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    return {
      fileId: photo.file_id,
      fileName: `photo_${photo.file_id}.jpg`,
      mimeType: "image/jpeg"
    };
  }
  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileName: message.video.file_name || `video_${Date.now()}.mp4`,
      mimeType: message.video.mime_type || "video/mp4"
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      fileName: message.audio.file_name || `audio_${Date.now()}.mp3`,
      mimeType: message.audio.mime_type || "audio/mpeg"
    };
  }
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      fileName: `voice_${message.voice.file_id}.ogg`,
      mimeType: message.voice.mime_type || "audio/ogg"
    };
  }
  if (message.video_note) {
    return {
      fileId: message.video_note.file_id,
      fileName: `note_${message.video_note.file_id}.mp4`,
      mimeType: "video/mp4"
    };
  }
  if (message.animation) {
    return {
      fileId: message.animation.file_id,
      fileName: message.animation.file_name || `gif_${Date.now()}.gif`,
      mimeType: message.animation.mime_type || "image/gif"
    };
  }
  if (message.sticker) {
    return {
      fileId: message.sticker.file_id,
      fileName: `sticker_${message.sticker.file_id}.webp`,
      mimeType: "image/webp"
    };
  }
  return null;
}

/**
 * Uploads a local file stream to Pixeldrain API.
 * Uses HTTP PUT https://pixeldrain.com/api/file/{filename}
 * Returns the URL on success, or throws error.
 */
function uploadToPixeldrain(filePath: string, fileName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encodedFileName = encodeURIComponent(fileName);
    const url = `https://pixeldrain.com/api/file/${encodedFileName}`;

    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      method: "PUT",
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      headers: {
        "User-Agent": "telegram-uploader-bot/1.0"
      }
    };

    // If api key is provided, use basic auth with empty username and key as password
    if (PIXELDRAIN_API_KEY) {
      const auth = Buffer.from(`:${PIXELDRAIN_API_KEY}`).toString("base64");
      if (options.headers) {
        options.headers["Authorization"] = `Basic ${auth}`;
      }
    }

    const req = https.request(options, (res) => {
      let responseBody = "";

      res.on("data", (chunk) => {
        responseBody += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseBody);
          if (res.statusCode === 200 || res.statusCode === 201) {
            if (parsed.success && parsed.id) {
              resolve(`https://pixeldrain.com/u/${parsed.id}`);
            } else {
              reject(new Error(parsed.message || `آپلود ناموفق بود: ${responseBody}`));
            }
          } else {
            reject(new Error(`کد خطای سرور: ${res.statusCode} - ${parsed.message || responseBody}`));
          }
        } catch (err: any) {
          reject(new Error(`خطا در پردازش پاسخ سرور پیکسل‌درین: ${err.message}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    const fileStream = fs.createReadStream(filePath);
    fileStream.on("error", (err) => {
      req.destroy();
      reject(err);
    });

    // Pipe stream into HTTPS request
    fileStream.pipe(req);
  });
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "سلام! فایل، ویدیو یا عکسی که میخوای رو برام بفرست تا مستقیم توی پیکسل‌درین آپلود کنم و لینک دانلود بدم.\n" +
    "این ربات از فایل‌های تا سقف ۲ گیگابایت پشتیبانی می‌کنه! 🚀"
  );
});

bot.on([":document", ":photo", ":video", ":audio", ":voice", ":video_note", ":animation", ":sticker"], async (ctx) => {
  const fileDetails = getFileDetails(ctx);
  if (!fileDetails) {
    return ctx.reply("متاسفانه قادر به خواندن جزئیات فایل دریافتی نیستم.");
  }

  const { fileId, fileName } = fileDetails;

  // Inform user upload is starting
  const statusMsg = await ctx.reply(`در حال دریافت فایل "${fileName}" از تلگرام... ⏳`);

  try {
    // 1. Ask local Bot API server to prepare the file
    console.log(`Getting file directory path for file_id: ${fileId}`);
    const fileObj = await bot.api.getFile(fileId);

    if (!fileObj.file_path) {
      throw new Error("مسیر فایل توسط سرور تلگرام به درستی برگردانده نشد.");
    }

    const absoluteFilePath = path.isAbsolute(fileObj.file_path)
      ? fileObj.file_path
      : path.join(LOCAL_FILES_DIR, TELEGRAM_BOT_TOKEN, fileObj.file_path);

    console.log(`Local file resides at: ${absoluteFilePath}`);

    if (!fs.existsSync(absoluteFilePath)) {
      throw new Error(`فایل دانلود شده در مسیر مورد نظر یافت نشد: ${absoluteFilePath}`);
    }

    await bot.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `فایل با موفقیت روی سرور لوکال ذخیره شد. در حال آپلود به پیکسل‌درین... 🚀`
    );

    const stats = fs.statSync(absoluteFilePath);
    const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

    // 2. Stream local file to Pixeldrain
    const publicUrl = await uploadToPixeldrain(absoluteFilePath, fileName);

    // 3. Delete file locally to avoid space leakage
    try {
      fs.unlinkSync(absoluteFilePath);
      console.log(`Cleaned up local file: ${absoluteFilePath}`);
    } catch (err) {
      console.error(`Failed to delete local Telegram file: ${err}`);
    }

    await bot.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ فایل با موفقیت آپلود شد!\n\n` +
      `📦 نام فایل: ${fileName}\n` +
      `💾 حجم فایل: ${fileSizeInMB} MB\n\n` +
      `🔗 لینک دانلود مستقیم:\n${publicUrl}`,
      { link_preview_options: { is_disabled: true } }
    );

  } catch (error: any) {
    console.error("Upload error details:", error);
    await bot.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `❌ خطا در انجام فرآیند آپلود:\n${error.message || error}`
    );
  }
});

// Run bot
bot.start();
console.log("Telegram Pixeldrain Uploader Bot Daemon started.");
