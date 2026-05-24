import { chromium } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const baseUrl = process.env.SHARE_E2E_URL ?? "http://localhost:8796";
const directory = await mkdtemp(join(tmpdir(), "share-e2e-"));
const filePath = join(directory, "browser-proof.txt");
await writeFile(filePath, "share browser proof\n");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true });
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#file").waitFor();
  await page.setInputFiles("#file", filePath);
  await page.waitForFunction(() => Boolean(document.querySelector('[name="cf-turnstile-response"]')?.value));
  await page.click("#create");
  await page.getByText("Upload complete.").waitFor();
  const readHref = await page.locator("#links a").nth(1).getAttribute("href");
  if (!readHref) throw new Error("share link was not created");
  await page.goto(new URL(readHref, baseUrl).href);
  await page.getByText("Done. Your file is ready.").waitFor();
  if (await page.getByRole("button", { name: "Save or resume" }).count()) throw new Error("implementation language leaked into ready state");
  await page.getByRole("button", { name: "Download file" }).waitFor();
  const result = await page.evaluate(async () => {
    const capability = new URLSearchParams(location.hash.slice(1)).get("read");
    const response = await fetch(`${location.pathname.replace("/share/", "/api/shares/")}/download`, {
      headers: { authorization: `ShareCapability ${capability}`, range: "bytes=6-" },
    });
    return { status: response.status, range: response.headers.get("content-range"), text: await response.text() };
  });
  if (result.status !== 206 || result.text !== "browser proof\n" || result.range !== "bytes 6-19/20") {
    throw new Error(`range download mismatch: ${JSON.stringify(result)}`);
  }
  console.log("browser e2e passed: create, upload, viewer, ranged download");
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
