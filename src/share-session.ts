import { DurableObject } from "cloudflare:workers";
import { hashCapability, multipartPartLength, positiveNumber, presentedCapability, redactedState, singleRange } from "./core";
import type { Env, ShareStatus, StoredShare } from "./types";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export class ShareSession extends DurableObject<Env> {
  private async state(): Promise<StoredShare | null> {
    return await this.ctx.storage.get<StoredShare>("share") ?? null;
  }

  private async save(state: StoredShare): Promise<void> {
    await this.ctx.storage.put("share", state);
  }

  private async quota(action: "claim" | "release", id: string): Promise<Response> {
    const quota = this.env.QUOTA.get(this.env.QUOTA.idFromName("global"));
    return quota.fetch(`https://quota/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  }

  private async release(id: string): Promise<void> {
    await this.quota("release", id);
  }

  private missingUpload(error: unknown): boolean {
    return typeof error === "object" && error !== null && (String((error as { message?: string }).message).includes("NoSuchUpload") || (error as { code?: number }).code === 10024);
  }

  private async permission(request: Request, state: StoredShare, manage = false): Promise<boolean> {
    const token = presentedCapability(request);
    if (!token) return false;
    const hash = await hashCapability(token);
    return hash === state.manageHash || (!manage && hash === state.readHash);
  }

  private cleanupKind(state: StoredShare): "multipart" | "object" | "both" {
    if (state.cleanupKind) return state.cleanupKind;
    if (state.status === "ready") return "object";
    if (state.status === "completing") return "both";
    return "multipart";
  }

  private async cleanup(state: StoredShare, terminal: "aborted" | "expired"): Promise<StoredShare> {
    const pending: StoredShare = { ...state, status: "cleanup_pending", cleanupKind: this.cleanupKind(state), updatedAt: new Date().toISOString() };
    await this.save(pending);
    try {
      if (pending.cleanupKind === "object" || pending.cleanupKind === "both") await this.env.FILES.delete(pending.key);
      if (pending.cleanupKind === "multipart" || pending.cleanupKind === "both") await this.env.FILES.resumeMultipartUpload(pending.key, pending.uploadId).abort().catch((error) => {
        if (!this.missingUpload(error)) throw error;
      });
      await this.release(pending.id);
      const complete: StoredShare = { ...pending, status: terminal, updatedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), cleanupKind: undefined };
      await this.save(complete);
      return complete;
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return pending;
    }
  }

  private async recoverCompletion(state: StoredShare): Promise<void> {
    if (Date.now() - Date.parse(state.updatedAt) < 5 * 60 * 1000) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    const object = await this.env.FILES.head(state.key);
    if (object) {
      const now = new Date();
      const ready: StoredShare = { ...state, status: "ready", cleanupKind: undefined, uploadedBytes: state.size, etag: object.httpEtag, downloadPath: `/api/shares/${state.id}/download`, updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + positiveNumber(this.env.READY_TTL_SECONDS, 86400) * 1000).toISOString() };
      await this.save(ready);
      await this.ctx.storage.setAlarm(new Date(ready.expiresAt));
      return;
    }
    await this.cleanup(state, "expired");
  }

  async alarm(): Promise<void> {
    const state = await this.state();
    if (!state || ["aborted", "expired"].includes(state.status)) return;
    if (state.status === "completing") {
      await this.recoverCompletion(state);
      return;
    }
    await this.cleanup(state, "expired");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") {
      if (await this.state()) return json({ error: "Already initialized" }, 409);
      const input = await request.json<Omit<StoredShare, "key" | "uploadId" | "parts" | "uploadedBytes" | "uploadedParts" | "status" | "createdAt" | "updatedAt" | "expiresAt" | "downloadBytesRemaining" | "cleanupKind">>();
      const key = `shares/${input.id}/${input.name}`;
      const upload = await this.env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: input.contentType, contentDisposition: `attachment; filename="${input.name.replaceAll('"', "")}"` } });
      const now = new Date();
      const state: StoredShare = { ...input, key, uploadId: upload.uploadId, parts: [], uploadedBytes: 0, uploadedParts: [], status: "uploading", createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + positiveNumber(this.env.PENDING_TTL_SECONDS, 3600) * 1000).toISOString(), downloadBytesRemaining: input.downloadBudget };
      try {
        await this.save(state);
        await this.ctx.storage.setAlarm(new Date(state.expiresAt));
        const claimed = await this.quota("claim", state.id);
        if (!claimed.ok) {
          await this.cleanup(state, "expired");
          return json({ error: "Unable to claim reservation" }, 503);
        }
        return json(redactedState(state), 201);
      } catch {
        try {
          await upload.abort();
          return json({ error: "Unable to initialize share" }, 500);
        } catch {
          const pending: StoredShare = { ...state, status: "cleanup_pending", cleanupKind: "multipart", updatedAt: new Date().toISOString() };
          await this.save(pending).catch(() => undefined);
          await this.ctx.storage.setAlarm(Date.now() + 60_000).catch(() => undefined);
          return json({ error: "Cleanup pending", cleanupPending: true }, 503);
        }
      }
    }
    const state = await this.state();
    if (!state || ["expired", "aborted", "cleanup_pending"].includes(state.status)) return json({ error: "Not found" }, 404);
    if (Date.now() >= Date.parse(state.expiresAt)) {
      if (state.status === "completing") {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return json({ error: "Not found" }, 404);
      }
      await this.cleanup(state, "expired");
      return json({ error: "Not found" }, 404);
    }
    if (url.pathname === "/state" && request.method === "GET") {
      if (!await this.permission(request, state)) return json({ error: "Not found" }, 404);
      return json(redactedState(state));
    }
    const part = url.pathname.match(/^\/parts\/(\d+)$/);
    if (part && request.method === "PUT") {
      if (!await this.permission(request, state, true)) return json({ error: "Not found" }, 404);
      const currentForDebit = await this.state();
      if (!currentForDebit || currentForDebit.status !== "uploading" || Date.now() >= Date.parse(currentForDebit.expiresAt)) return json({ error: "Upload is not active" }, 409);
      const number = Number(part[1]);
      if (!Number.isInteger(number) || number < 1 || number > currentForDebit.partCount) return json({ error: "Invalid part" }, 400);
      const expected = multipartPartLength(currentForDebit.size, currentForDebit.partSize, number);
      if (Number(request.headers.get("content-length")) !== expected || !request.body) return json({ error: `Part ${number} must contain ${expected} bytes` }, 400);
      if (currentForDebit.uploadBytesRemaining < expected) return json({ error: "Upload retry budget reached" }, 429);
      const reserved: StoredShare = { ...currentForDebit, uploadBytesRemaining: currentForDebit.uploadBytesRemaining - expected, updatedAt: new Date().toISOString() };
      await this.save(reserved);
      const completed = await this.env.FILES.resumeMultipartUpload(reserved.key, reserved.uploadId).uploadPart(number, request.body);
      const current = await this.state();
      if (!current || current.status !== "uploading") return json({ error: "Upload is no longer active" }, 409);
      const parts = [...current.parts.filter((entry) => entry.partNumber !== number), completed].sort((a, b) => a.partNumber - b.partNumber);
      const uploadedParts = parts.map((entry) => entry.partNumber);
      const uploadedBytes = uploadedParts.reduce((total, n) => total + multipartPartLength(current.size, current.partSize, n), 0);
      const next = { ...current, parts, uploadedParts, uploadedBytes, updatedAt: new Date().toISOString() };
      await this.save(next);
      return json(redactedState(next));
    }
    if (url.pathname === "/complete" && request.method === "POST") {
      if (!await this.permission(request, state, true)) return json({ error: "Not found" }, 404);
      const currentForCompletion = await this.state();
      if (!currentForCompletion) return json({ error: "Not found" }, 404);
      if (currentForCompletion.status === "ready") return json(redactedState(currentForCompletion));
      if (currentForCompletion.status !== "uploading" || currentForCompletion.parts.length !== currentForCompletion.partCount || Date.now() >= Date.parse(currentForCompletion.expiresAt)) return json({ error: "Upload is incomplete" }, 409);
      const completing: StoredShare = { ...currentForCompletion, status: "completing", cleanupKind: "both", updatedAt: new Date().toISOString() };
      await this.save(completing);
      try {
        const object = await this.env.FILES.resumeMultipartUpload(completing.key, completing.uploadId).complete(completing.parts);
        const now = new Date();
        const next: StoredShare = { ...completing, status: "ready", cleanupKind: undefined, uploadedBytes: completing.size, updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + positiveNumber(this.env.READY_TTL_SECONDS, 86400) * 1000).toISOString(), downloadPath: `/api/shares/${completing.id}/download`, etag: object.httpEtag };
        await this.save(next);
        await this.ctx.storage.setAlarm(new Date(next.expiresAt));
        return json(redactedState(next));
      } catch {
        await this.cleanup(completing, "expired");
        return json({ error: "Unable to complete upload" }, 500);
      }
    }
    if ((url.pathname === "/abort" || url.pathname === "/delete") && request.method === "POST") {
      if (!await this.permission(request, state, true)) return json({ error: "Not found" }, 404);
      const currentForCleanup = await this.state();
      if (!currentForCleanup) return json({ error: "Not found" }, 404);
      if (currentForCleanup.status === "completing") return json({ error: "Finalization in progress. Retry removal after it completes." }, 409);
      const cleaned = await this.cleanup(currentForCleanup, "aborted");
      return cleaned.status === "cleanup_pending" ? json({ error: "Cleanup pending" }, 503) : json(redactedState(cleaned));
    }
    if (url.pathname === "/download" && request.method === "GET") {
      if (!await this.permission(request, state)) return json({ error: "Not found" }, 404);
      const currentForDebit = await this.state();
      if (!currentForDebit || currentForDebit.status !== "ready" || Date.now() >= Date.parse(currentForDebit.expiresAt)) return json({ error: "Upload is not ready" }, 409);
      const rangeHeader = request.headers.get("range");
      const range = rangeHeader ? singleRange(rangeHeader, currentForDebit.size) : null;
      if (rangeHeader && !range) return json({ error: "Requested range is not satisfiable" }, 416);
      const bytes = range?.length ?? currentForDebit.size;
      if ((currentForDebit.downloadBytesRemaining ?? 0) < bytes) return json({ error: "Temporary download limit reached" }, 429);
      const reserved: StoredShare = { ...currentForDebit, downloadBytesRemaining: (currentForDebit.downloadBytesRemaining ?? 0) - bytes, updatedAt: new Date().toISOString() };
      await this.save(reserved);
      const object = range ? await this.env.FILES.get(reserved.key, { range }) : await this.env.FILES.get(reserved.key);
      if (!object) return json({ error: "Not found" }, 404);
      const responseHeaders = new Headers({ "cache-control": "no-store", "content-type": reserved.contentType, "content-disposition": `attachment; filename="${reserved.name.replaceAll('"', "")}"`, "x-content-type-options": "nosniff", "accept-ranges": "bytes", "etag": object.httpEtag, "content-length": String(bytes) });
      if (range) responseHeaders.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${reserved.size}`);
      return new Response(object.body, { status: range ? 206 : 200, headers: responseHeaders });
    }
    return json({ error: "Not found" }, 404);
  }
}
