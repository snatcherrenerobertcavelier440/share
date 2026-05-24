const encoder = new TextEncoder();

export function cleanName(name: string): string {
  const normalized = name.replace(/[\\/]/g, "-").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized.slice(0, 180) || "upload.bin";
}

export function cleanContentType(value: string | undefined): string {
  return value && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) ? value : "application/octet-stream";
}

export function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashCapability(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function presentedCapability(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^ShareCapability\s+([A-Za-z0-9_-]{40,})$/);
  return match?.[1] ?? null;
}

export function multipartPartCount(size: number, partSize: number): number {
  return Math.ceil(size / partSize);
}

export function multipartPartLength(size: number, partSize: number, partNumber: number): number {
  const count = multipartPartCount(size, partSize);
  return partNumber === count ? size - partSize * (count - 1) : partSize;
}

export function singleRange(header: string, size: number): { offset: number; length: number } | null {
  const match = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || offset >= size || end < offset) return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

export function redactedState<T extends { key?: unknown; uploadId?: unknown; parts?: unknown; readHash?: unknown; manageHash?: unknown; reservedBytes?: unknown; downloadBudget?: unknown; uploadBytesRemaining?: unknown; cleanupKind?: unknown }>(state: T): Omit<T, "key" | "uploadId" | "parts" | "readHash" | "manageHash" | "reservedBytes" | "downloadBudget" | "uploadBytesRemaining" | "cleanupKind"> {
  const { key: _key, uploadId: _uploadId, parts: _parts, readHash: _readHash, manageHash: _manageHash, reservedBytes: _reservedBytes, downloadBudget: _downloadBudget, uploadBytesRemaining: _uploadBytesRemaining, cleanupKind: _cleanupKind, ...safe } = state;
  return safe;
}
