import * as fs from "fs";
import * as https from "https";
import { ProgressCallback, UploaderService } from "../types";

// GoFile works fully anonymously (guest upload). An account token is optional -
// if provided, the uploaded file is attached to that account instead of a guest one.
const { GOFILE_API_TOKEN } = process.env;

interface GofileServerResponse {
  status: string;
  data: { servers: { name: string; zone: string }[] };
}

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "telegram-uploader-bot/1.0" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err: any) {
            reject(new Error(`خطا در پردازش پاسخ سرور گوفایل: ${err.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

async function getBestServer(): Promise<string> {
  const res: GofileServerResponse = await httpGetJson("https://api.gofile.io/servers");
  const servers = res?.data?.servers;
  if (!servers || servers.length === 0) {
    throw new Error("سرور آپلود گوفایل در دسترس نیست.");
  }
  // Prefer the European zone when available, otherwise take the first server offered.
  const preferred = servers.find((s) => s.zone === "eu") || servers[0];
  return preferred.name;
}

/**
 * Streams a single file to GoFile using a hand-built multipart/form-data body,
 * so we can track upload progress chunk-by-chunk without pulling in extra
 * dependencies (form-data / axios) that aren't part of this project already.
 */
function uploadToGofile(
  filePath: string,
  fileName: string,
  mimeType: string | undefined,
  totalBytes: number,
  onProgress?: ProgressCallback
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    try {
      const server = await getBestServer();

      const boundary = `----GofileBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
      const contentType = mimeType || "application/octet-stream";

      const preamble =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, "")}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`;

      const tokenField = GOFILE_API_TOKEN
        ? `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${GOFILE_API_TOKEN}\r\n`
        : "";

      const epilogue = `\r\n--${boundary}--\r\n`;

      const preambleBuf = Buffer.from(tokenField + preamble, "utf-8");
      const epilogueBuf = Buffer.from(epilogue, "utf-8");
      const totalContentLength = preambleBuf.length + totalBytes + epilogueBuf.length;

      const options: https.RequestOptions = {
        method: "POST",
        hostname: `${server}.gofile.io`,
        path: "/contents/uploadfile",
        headers: {
          "User-Agent": "telegram-uploader-bot/1.0",
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": totalContentLength.toString()
        }
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const downloadPage = parsed?.data?.downloadPage;
            if ((res.statusCode === 200 || res.statusCode === 201) && parsed.status === "ok" && downloadPage) {
              resolve(downloadPage);
            } else {
              reject(new Error(parsed?.status || `آپلود به گوفایل ناموفق بود: ${body}`));
            }
          } catch (err: any) {
            reject(new Error(`خطا در پردازش پاسخ گوفایل: ${err.message}`));
          }
        });
      });

      req.on("error", (err) => reject(err));

      req.write(preambleBuf);

      let uploadedBytes = preambleBuf.length;
      const startTime = Date.now();

      const fileStream = fs.createReadStream(filePath);

      fileStream.on("data", (chunk) => {
        const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as string);
        uploadedBytes += len;
        if (onProgress) {
          const elapsed = (Date.now() - startTime) / 1000;
          const speedBps = elapsed > 0.1 ? (uploadedBytes - preambleBuf.length) / elapsed : 0;
          onProgress(Math.min(uploadedBytes, totalContentLength), totalContentLength, speedBps);
        }
      });

      fileStream.on("error", (err) => {
        req.destroy();
        reject(err);
      });

      fileStream.on("end", () => {
        req.end(epilogueBuf);
      });

      fileStream.pipe(req, { end: false });
    } catch (err) {
      reject(err);
    }
  });
}

export const gofileService: UploaderService = {
  label: "GoFile",
  emoji: "📦",
  enabled: true,
  async upload(filePath, fileName, mimeType, totalBytes, onProgress) {
    return uploadToGofile(filePath, fileName, mimeType, totalBytes, onProgress);
  }
};
