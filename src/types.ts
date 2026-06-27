export type ProgressCallback = (uploadedBytes: number, totalBytes: number, speedBps: number) => void;

export interface UploadResult {
  service: string;
  url: string;
}

export interface UploaderService {
  /** Display name shown to the user, e.g. "پیکسل‌درین" */
  label: string;
  /** Emoji shown in progress messages */
  emoji: string;
  /** Whether this service is enabled (e.g. required env vars are present, or it has no requirements) */
  enabled: boolean;
  /** Reason it's disabled, shown only in logs */
  disabledReason?: string;
  upload(filePath: string, fileName: string, mimeType: string | undefined, totalBytes: number, onProgress?: ProgressCallback): Promise<string>;
}
