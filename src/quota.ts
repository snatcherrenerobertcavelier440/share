import { DurableObject } from "cloudflare:workers";
import { positiveNumber } from "./core";
import type { Env } from "./types";

interface Reservation {
  bytes: number;
  claimed: boolean;
  expiresAt: number;
}

interface QuotaState {
  activeBytes: number;
  reservations: Record<string, Reservation>;
  creates: Record<string, number[]>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export class DemoQuota extends DurableObject<Env> {
  private async current(): Promise<QuotaState> {
    const state = await this.ctx.storage.get<QuotaState>("quota") ?? { activeBytes: 0, reservations: {}, creates: {} };
    const now = Date.now();
    let changed = false;
    for (const [id, reservation] of Object.entries(state.reservations)) {
      if (!reservation.claimed && reservation.expiresAt <= now) {
        state.activeBytes = Math.max(0, state.activeBytes - reservation.bytes);
        delete state.reservations[id];
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put("quota", state);
    return state;
  }

  async alarm(): Promise<void> {
    await this.current();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/reserve" && request.method === "POST") {
      const { id, bytes, clientKey } = await request.json<{ id: string; bytes: number; clientKey: string }>();
      const state = await this.current();
      const now = Date.now();
      const recent = (state.creates[clientKey] ?? []).filter((created) => created > now - 60 * 60 * 1000);
      if (recent.length >= positiveNumber(this.env.MAX_CREATES_PER_HOUR, 5)) return json({ error: "Creation limit reached. Try again later." }, 429);
      if (state.activeBytes + bytes > positiveNumber(this.env.MAX_ACTIVE_BYTES, 1024 * 1024 * 1024)) return json({ error: "Temporary storage limit reached. Try again later." }, 429);
      state.reservations[id] = { bytes, claimed: false, expiresAt: now + 120_000 };
      state.activeBytes += bytes;
      state.creates[clientKey] = [...recent, now];
      await this.ctx.storage.put("quota", state);
      await this.ctx.storage.setAlarm(now + 120_000);
      return json({ ok: true, activeBytes: state.activeBytes }, 201);
    }
    if (url.pathname === "/claim" && request.method === "POST") {
      const { id } = await request.json<{ id: string }>();
      const state = await this.current();
      const reservation = state.reservations[id];
      if (!reservation) return json({ error: "Reservation not found" }, 404);
      state.reservations[id] = { ...reservation, claimed: true };
      await this.ctx.storage.put("quota", state);
      return json({ ok: true });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const { id } = await request.json<{ id: string }>();
      const state = await this.current();
      const reservation = state.reservations[id];
      if (reservation) {
        delete state.reservations[id];
        state.activeBytes = Math.max(0, state.activeBytes - reservation.bytes);
        await this.ctx.storage.put("quota", state);
      }
      return json({ ok: true, activeBytes: state.activeBytes });
    }
    if (url.pathname === "/status" && request.method === "GET") {
      const state = await this.current();
      return json({ activeBytes: state.activeBytes, activeShares: Object.keys(state.reservations).length });
    }
    return json({ error: "Not found" }, 404);
  }
}
