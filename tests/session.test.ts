import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashCapability } from "../src/core";

const read = "r".repeat(43);
const manage = "m".repeat(43);
const auth = (capability: string) => ({ authorization: `ShareCapability ${capability}` });

async function initialized(id: string, bytes: number, downloadBudget = bytes * 4, uploadBytesRemaining = bytes * 2) {
  const quota = env.QUOTA.get(env.QUOTA.idFromName("global"));
  await quota.fetch("https://quota/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, bytes, clientKey: id }) });
  const stub = env.SHARES.get(env.SHARES.idFromName(id));
  const response = await stub.fetch("https://share/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id,
      name: "proof.txt",
      size: bytes,
      contentType: "text/plain",
      partSize: 16 * 1024 * 1024,
      partCount: 1,
      sourceLastModified: 123,
      readHash: await hashCapability(read),
      manageHash: await hashCapability(manage),
      reservedBytes: bytes,
      downloadBudget,
      uploadBytesRemaining,
    }),
  });
  expect(response.status).toBe(201);
  return stub;
}

describe("share session", () => {
  it("separates read and manage capabilities", async () => {
    const stub = await initialized(crypto.randomUUID(), 5);
    expect((await stub.fetch("https://share/state", { headers: auth(read) })).status).toBe(200);
    expect((await stub.fetch("https://share/abort", { method: "POST", headers: auth(read) })).status).toBe(404);
    expect((await stub.fetch("https://share/state", { headers: auth("x".repeat(43)) })).status).toBe(404);
  });

  it("uploads, completes, and downloads a byte range", async () => {
    const id = crypto.randomUUID();
    const stub = await initialized(id, 11);
    const uploaded = await stub.fetch("https://share/parts/1", { method: "PUT", headers: { ...auth(manage), "content-length": "11" }, body: "hello world" });
    expect(uploaded.status).toBe(200);
    const completed = await stub.fetch("https://share/complete", { method: "POST", headers: auth(manage) });
    expect((await completed.json<{ status: string }>()).status).toBe("ready");
    const downloaded = await stub.fetch("https://share/download", { headers: { ...auth(read), range: "bytes=6-" } });
    expect(downloaded.status).toBe(206);
    expect(downloaded.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(await downloaded.text()).toBe("world");
  });

  it("aborts incomplete uploads with manage capability", async () => {
    const stub = await initialized(crypto.randomUUID(), 5);
    const response = await stub.fetch("https://share/abort", { method: "POST", headers: auth(manage) });
    expect((await response.json<{ status: string }>()).status).toBe("aborted");
    expect((await stub.fetch("https://share/state", { headers: auth(read) })).status).toBe(404);
  });

  it("bounds concurrent multipart writes after a limited retry allowance", async () => {
    const stub = await initialized(crypto.randomUUID(), 5, 20, 10);
    const request = () => stub.fetch("https://share/parts/1", { method: "PUT", headers: { ...auth(manage), "content-length": "5" }, body: "hello" });
    const responses = await Promise.all([request(), request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429]);
  });

  it("pre-debits download bytes so concurrent requests cannot exceed budget", async () => {
    const stub = await initialized(crypto.randomUUID(), 5, 10);
    await stub.fetch("https://share/parts/1", { method: "PUT", headers: { ...auth(manage), "content-length": "5" }, body: "hello" });
    await stub.fetch("https://share/complete", { method: "POST", headers: auth(manage) });
    const responses = await Promise.all([1, 2, 3].map(() => stub.fetch("https://share/download", { headers: auth(read) })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429]);
  });

  it("makes duplicate completion non-destructive and keeps the object downloadable", async () => {
    const stub = await initialized(crypto.randomUUID(), 5);
    await stub.fetch("https://share/parts/1", { method: "PUT", headers: { ...auth(manage), "content-length": "5" }, body: "hello" });
    const completed = await Promise.all([1, 2].map(() => stub.fetch("https://share/complete", { method: "POST", headers: auth(manage) })));
    const statuses = completed.map((response) => response.status);
    expect(statuses).toContain(200);
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    expect(await (await stub.fetch("https://share/download", { headers: auth(read) })).text()).toBe("hello");
  });

  it("rejects expired shares even before their cleanup alarm runs", async () => {
    const stub = await initialized(crypto.randomUUID(), 5);
    await runInDurableObject(stub, async (_object, storage) => {
      const state = await storage.storage.get<Record<string, unknown>>("share");
      await storage.storage.put("share", { ...state, expiresAt: new Date(0).toISOString() });
    });
    expect((await stub.fetch("https://share/state", { headers: auth(read) })).status).toBe(404);
  });

  it("does not race cancellation or expiry against an active finalization", async () => {
    const stub = await initialized(crypto.randomUUID(), 5);
    await runInDurableObject(stub, async (_object, storage) => {
      const state = await storage.storage.get<Record<string, unknown>>("share");
      await storage.storage.put("share", { ...state, status: "completing", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    });
    expect((await stub.fetch("https://share/abort", { method: "POST", headers: auth(manage) })).status).toBe(409);
    await runInDurableObject(stub, async (_object, storage) => {
      const state = await storage.storage.get<Record<string, unknown>>("share");
      await storage.storage.put("share", { ...state, expiresAt: new Date(0).toISOString() });
    });
    expect((await stub.fetch("https://share/state", { headers: auth(read) })).status).toBe(404);
    const status = await runInDurableObject(stub, async (_object, storage) => storage.storage.get<{ status: string }>("share"));
    expect(status?.status).toBe("completing");
  });
});

describe("quota and public routes", () => {
  it("enforces exact capacity reservations", async () => {
    const quota = env.QUOTA.get(env.QUOTA.idFromName(`quota-${crypto.randomUUID()}`));
    const body = { bytes: 900_000_000, clientKey: "first", id: crypto.randomUUID() };
    expect((await quota.fetch("https://quota/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(201);
    expect((await quota.fetch("https://quota/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, id: crypto.randomUUID(), clientKey: "second" }) })).status).toBe(429);
  });

  it("serializes concurrent reservations against the retained-byte ceiling", async () => {
    const quota = env.QUOTA.get(env.QUOTA.idFromName(`concurrent-${crypto.randomUUID()}`));
    const request = (clientKey: string) => quota.fetch("https://quota/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), bytes: 700_000_000, clientKey }) });
    const responses = await Promise.all([request("a"), request("b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
  });

  it("automatically releases an unclaimed initialization reservation", async () => {
    const quota = env.QUOTA.get(env.QUOTA.idFromName(`lease-${crypto.randomUUID()}`));
    const id = crypto.randomUUID();
    await quota.fetch("https://quota/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, bytes: 50, clientKey: "lease" }) });
    await runInDurableObject(quota, async (_object, storage) => {
      const state = await storage.storage.get<{ activeBytes: number; reservations: Record<string, { bytes: number; claimed: boolean; expiresAt: number }>; creates: Record<string, number[]> }>("quota");
      if (state) {
        state.reservations[id].expiresAt = 0;
        await storage.storage.put("quota", state);
      }
    });
    await runDurableObjectAlarm(quota);
    const status = await quota.fetch("https://quota/status");
    expect(await status.json()).toMatchObject({ activeBytes: 0, activeShares: 0 });
  });

  it("renders social metadata and crawl controls on the public page", async () => {
    const text = await (await SELF.fetch("https://example.test/")).text();
    expect(text).toContain('property="og:image" content="https://example.test/og.svg"');
    expect(text).toContain('name="description"');
    expect(text).toContain('rel="canonical" href="https://example.test/"');
    expect((await SELF.fetch("https://example.test/og.svg")).headers.get("content-type")).toContain("image/svg+xml");
    expect((await SELF.fetch("https://example.test/og.svg", { method: "HEAD" })).headers.get("content-type")).toContain("image/svg+xml");
    expect(await (await SELF.fetch("https://example.test/robots.txt")).text()).toContain("Disallow: /share/");
  });

  it("renders a noindex capability-only share shell without revealing metadata", async () => {
    const response = await SELF.fetch(`https://example.test/share/${crypto.randomUUID()}`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("Loading share");
    expect(text).toContain('name="robots" content="noindex,nofollow,noarchive"');
    expect(text).not.toContain("proof.txt");
  });
});
