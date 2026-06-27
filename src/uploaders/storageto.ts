import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import { ProgressCallback, UploaderService } from "../types";

const STORAGE_TO_BASE = "https://storage.to/api";
// A stable per-process visitor token. storage.to uses this purely to let the
// uploader poll/manage its own anonymous uploads - no account or API key needed.
const VISITOR_TOKEN = `tg-bot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function requestJson(method: string, url: string, body?: object, extraHeaders?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "User-Agent": "telegram-uploader-bot/1.0",
      "X-Visitor-Token": VISITOR_TOKEN,
      ...(extraHeaders || {})
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload).toString();
    }

    const req = https.request(
      {
        method,
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = data ? JSON.parse(data) : {};
            if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
              resolve(json);
            } else {
              reject(new Error(json?.error || `درخواست به storage.to ناموفق بود (HTTP ${res.statusCode})`));
            }
          } catch (err: any) {
            reject(new Error(`خطا در پردازش پاسخ storage.to: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * PUTs a byte range of the local file directly to a presigned R2 URL.
 * Resolves with the ETag header (required for multipart completion).
 * `extraHeaders` carries through any headers /init told us to send
 * (e.g. a Host override) alongside the presigned URL.
 */
function putRange(
  url: string,
  filePath: string,
  start: number,
  end: number, // exclusive
  extraHeaders: Record<string, string> | undefined,
  onChunk?: (bytes: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const length = end - start;

    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        method: "PUT",
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers: { "Content-Length": length.toString(), ...(extraHeaders || {}) }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            const etag = res.headers["etag"] as string | undefined;
            resolve(etag || "");
          } else {
            reject(new Error(`آپلود به R2 ناموفق بود (HTTP ${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on("error", reject);

    const stream = fs.createReadStream(filePath, { start, end: end - 1 });
    stream.on("data", (chunk) => {
      const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as string);
      onChunk?.(len);
    });
    stream.on("error", (err) => {
      req.destroy();
      reject(err);
    });
    stream.pipe(req);
  });
}

/** /init returns headers as { "Header-Name": ["value"] } - flatten to a plain Record<string,string>. */
function flattenHeaders(headers: Record<string, string[]> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(headers)) {
    if (Array.isArray(values) && values.length > 0) out[key] = values[0];
  }
  return out;
}

async function uploadSingle(
  filePath: string,
  fileName: string,
  contentType: string,
  totalBytes: number,
  uploadUrl: string,
  extraHeaders: Record<string, string> | undefined,
  onProgress?: ProgressCallback
): Promise<string> {
  let uploaded = 0;
  const startTime = Date.now();
  await putRange(uploadUrl, filePath, 0, totalBytes, extraHeaders, (bytes) => {
    uploaded += bytes;
    if (onProgress) {
      const elapsed = (Date.now() - startTime) / 1000;
      const speedBps = elapsed > 0.1 ? uploaded / elapsed : 0;
      onProgress(uploaded, totalBytes, speedBps);
    }
  });
  return "";
}

async function uploadMultipart(
  filePath: string,
  totalBytes: number,
  partSize: number,
  totalParts: number,
  initialUrls: Record<string, string>,
  uploadId: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const parts: { partNumber: number; etag: string }[] = [];
  let uploadedSoFar = 0;
  const startTime = Date.now();

  // Fetch any part URLs not already provided by /init (it may only return the first couple).
  const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
  const urlMap: Record<number, string> = {};
  for (const pn of partNumbers) {
    if (initialUrls[String(pn)]) urlMap[pn] = initialUrls[String(pn)];
  }
  const missing = partNumbers.filter((pn) => !urlMap[pn]);
  if (missing.length > 0) {
    const res = await requestJson("POST", `${STORAGE_TO_BASE}/upload/parts`, {
      upload_id: uploadId,
      part_numbers: missing
    });
    for (const p of res.part_urls as { partNumber: number; url: string }[]) {
      urlMap[p.partNumber] = p.url;
    }
  }

  for (const pn of partNumbers) {
    const start = (pn - 1) * partSize;
    const end = Math.min(start + partSize, totalBytes);
    const etag = await putRange(urlMap[pn], filePath, start, end, undefined, (bytes) => {
      uploadedSoFar += bytes;
      if (onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speedBps = elapsed > 0.1 ? uploadedSoFar / elapsed : 0;
        onProgress(uploadedSoFar, totalBytes, speedBps);
      }
    });
    parts.push({ partNumber: pn, etag });
  }

  await requestJson("POST", `${STORAGE_TO_BASE}/upload/complete-multipart`, {
    upload_id: uploadId,
    parts
  });
}

async function uploadToStorageTo(
  filePath: string,
  fileName: string,
  mimeType: string | undefined,
  totalBytes: number,
  onProgress?: ProgressCallback
): Promise<string> {
  const contentType = mimeType || "application/octet-stream";

  const initRes = await requestJson("POST", `${STORAGE_TO_BASE}/upload/init`, {
    filename: fileName,
    content_type: contentType,
    size: totalBytes
  });

  let r2Key: string;

  if (initRes.type === "multipart") {
    await uploadMultipart(
      filePath,
      totalBytes,
      initRes.part_size,
      initRes.total_parts,
      initRes.initial_urls || {},
      initRes.upload_id,
      onProgress
    );
    r2Key = initRes.r2_key;
  } else {
    await uploadSingle(filePath, fileName, contentType, totalBytes, initRes.upload_url, flattenHeaders(initRes.headers), onProgress);
    r2Key = initRes.r2_key;
  }

  const confirmRes = await requestJson("POST", `${STORAGE_TO_BASE}/upload/confirm`, {
    filename: fileName,
    size: totalBytes,
    content_type: contentType,
    r2_key: r2Key
  });

  if (!confirmRes?.file?.url) {
    throw new Error("storage.to لینک نهایی فایل را برنگرداند.");
  }

  return confirmRes.file.url as string;
}

export const storageToService: UploaderService = {
  label: "storage.to",
  emoji: "☁️",
  enabled: true,
  async upload(filePath, fileName, mimeType, totalBytes, onProgress) {
    return uploadToStorageTo(filePath, fileName, mimeType, totalBytes, onProgress);
  }
};
