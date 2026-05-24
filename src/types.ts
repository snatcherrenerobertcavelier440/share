export type ShareStatus = "uploading" | "completing" | "ready" | "cleanup_pending" | "aborted" | "expired" | "failed";

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ShareState {
  id: string;
  name: string;
  size: number;
  contentType: string;
  sourceLastModified?: number;
  status: ShareStatus;
  partSize: number;
  partCount: number;
  uploadedBytes: number;
  uploadedParts: number[];
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  downloadPath?: string;
  downloadBytesRemaining?: number;
  etag?: string;
}

export interface StoredShare extends ShareState {
  key: string;
  uploadId: string;
  parts: UploadedPart[];
  readHash: string;
  manageHash: string;
  reservedBytes: number;
  downloadBudget: number;
  uploadBytesRemaining: number;
  cleanupKind?: "multipart" | "object" | "both";
}

export interface Env {
  FILES: R2Bucket;
  SHARES: DurableObjectNamespace<ShareSession>;
  QUOTA: DurableObjectNamespace<DemoQuota>;
  MAX_SHARE_SIZE_BYTES?: string;
  MAX_ACTIVE_BYTES?: string;
  MAX_CREATES_PER_HOUR?: string;
  PENDING_TTL_SECONDS?: string;
  READY_TTL_SECONDS?: string;
  DOWNLOAD_MULTIPLIER?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  PUBLIC_URL?: string;
}

export type ShareSession = import("./share-session").ShareSession;
export type DemoQuota = import("./quota").DemoQuota;
