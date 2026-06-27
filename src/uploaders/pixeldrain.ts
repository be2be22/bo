import * as fs from "fs";
import * as https from "https";
import { ProgressCallback, UploaderService } from "../types";

const { PIXELDRAIN_API_KEY } = process.env;

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

export const pixeldrainService: UploaderService = {
  label: "پیکسل‌درین",
  emoji: "📤",
  enabled: true,
  async upload(filePath, fileName, _mimeType, totalBytes, onProgress) {
    return uploadToPixeldrain(filePath, fileName, totalBytes, onProgress);
  }
};
