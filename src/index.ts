import { cleanContentType, cleanName, hashCapability, multipartPartCount, positiveNumber, randomCapability } from "./core";
import { verifyTurnstile } from "./turnstile";
import type { Env, ShareSession, ShareState } from "./types";
import { DemoQuota } from "./quota";
import { ShareSession as ShareSessionClass } from "./share-session";
import { favicon, openGraphImage, robots, sitemap } from "./seo";
import { homePage, sharePage } from "./ui";

const multipartSize = 16 * 1024 * 1024;

function headers(type = "application/json; charset=utf-8"): HeadersInit {
  return { "content-type": type, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), { status, headers: headers() });
}

function page(rendered: { html: string; csp: string }): Response {
  return new Response(rendered.html, { headers: { ...headers("text/html; charset=utf-8"), "content-security-policy": rendered.csp } });
}

async function session(env: Env, id: string): Promise<DurableObjectStub<ShareSession> | null> {
  return /^[0-9a-f-]{36}$/i.test(id) ? env.SHARES.get(env.SHARES.idFromName(id)) : null;
}

async function clientKey(request: Request): Promise<string> {
  return hashCapability(request.headers.get("cf-connecting-ip") ?? "local");
}

async function create(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ name?: string; size?: number; contentType?: string; sourceLastModified?: number; turnstileToken?: string }>().catch(() => null);
  if (!body || typeof body.name !== "string" || !Number.isSafeInteger(body.size) || Number(body.size) <= 0) return json({ error: "Choose a non-empty file." }, 400);
  const max = positiveNumber(env.MAX_SHARE_SIZE_BYTES, 64 * 1024 * 1024);
  if (Number(body.size) > max) return json({ error: `Public demo files are limited to ${Math.floor(max / (1024 * 1024))} MiB.` }, 413);
  if (!await verifyTurnstile(body.turnstileToken, request.headers.get("cf-connecting-ip") ?? undefined, env.TURNSTILE_SECRET_KEY)) return json({ error: "Complete the human verification before creating a share." }, 403);
  const id = crypto.randomUUID();
  const quota = env.QUOTA.get(env.QUOTA.idFromName("global"));
  const reserved = await quota.fetch("https://quota/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, bytes: body.size, clientKey: await clientKey(request) }) });
  if (!reserved.ok) return new Response(await reserved.text(), { status: reserved.status, headers: headers() });
  const read = randomCapability();
  const manage = randomCapability();
  const downloadMultiplier = positiveNumber(env.DOWNLOAD_MULTIPLIER, 4);
  const stub = env.SHARES.get(env.SHARES.idFromName(id));
  let initialized: Response;
  try {
    initialized = await stub.fetch("https://share/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name: cleanName(body.name), size: body.size, contentType: cleanContentType(body.contentType), sourceLastModified: body.sourceLastModified, partSize: multipartSize, partCount: multipartPartCount(Number(body.size), multipartSize), readHash: await hashCapability(read), manageHash: await hashCapability(manage), reservedBytes: body.size, downloadBudget: Number(body.size) * downloadMultiplier, uploadBytesRemaining: Number(body.size) * 2 }) });
  } catch {
    return json({ error: "Unable to initialize share; reservation cleanup is pending." }, 503);
  }
  if (!initialized.ok) {
    const failure: { cleanupPending?: boolean } = await initialized.clone().json<{ cleanupPending?: boolean }>().catch(() => ({}));
    if (!failure.cleanupPending) await quota.fetch("https://quota/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    return json({ error: "Unable to initialize share." }, initialized.status);
  }
  const state = await initialized.json<ShareState>();
  return json({ state, shareUrl: `/share/${id}#read=${read}`, manageUrl: `/share/${id}#manage=${manage}` }, 201);
}

async function proxy(request: Request, env: Env, id: string, path: string): Promise<Response> {
  const stub = await session(env, id);
  if (!stub) return json({ error: "Not found" }, 404);
  const forwarded = new Request(`https://share${path}`, { method: request.method, headers: request.headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body });
  return stub.fetch(forwarded);
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = env.PUBLIC_URL || url.origin;
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/og.svg") return openGraphImage();
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/favicon.svg") return favicon();
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/robots.txt") return robots(origin);
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/sitemap.xml") return sitemap(origin);
  if (request.method === "GET" && url.pathname === "/") return page(homePage(env, url.origin));
  const sharePageMatch = url.pathname.match(/^\/share\/([^/]+)$/);
  if (request.method === "GET" && sharePageMatch) return page(sharePage(sharePageMatch[1], env, url.origin));
  if (request.method === "POST" && url.pathname === "/api/shares") return create(request, env);
  const state = url.pathname.match(/^\/api\/shares\/([^/]+)\/state$/);
  if (state && request.method === "GET") return proxy(request, env, state[1], "/state");
  const part = url.pathname.match(/^\/api\/shares\/([^/]+)\/parts\/(\d+)$/);
  if (part && request.method === "PUT") return proxy(request, env, part[1], `/parts/${part[2]}`);
  const complete = url.pathname.match(/^\/api\/shares\/([^/]+)\/complete$/);
  if (complete && request.method === "POST") return proxy(request, env, complete[1], "/complete");
  const abort = url.pathname.match(/^\/api\/shares\/([^/]+)\/(abort|delete)$/);
  if (abort && request.method === "POST") return proxy(request, env, abort[1], `/${abort[2]}`);
  const download = url.pathname.match(/^\/api\/shares\/([^/]+)\/download$/);
  if (download && request.method === "GET") return proxy(request, env, download[1], "/download");
  if (request.method === "GET" && url.pathname === "/api/config") return json({ maxShareSizeBytes: positiveNumber(env.MAX_SHARE_SIZE_BYTES, 64 * 1024 * 1024), pendingTtlSeconds: positiveNumber(env.PENDING_TTL_SECONDS, 3600), readyTtlSeconds: positiveNumber(env.READY_TTL_SECONDS, 86400), turnstileConfigured: Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) });
  return json({ error: "Not found" }, 404);
}

export { DemoQuota, ShareSessionClass as ShareSession };
export default { fetch: handleRequest };
