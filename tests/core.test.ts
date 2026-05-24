import { describe, expect, it } from "vitest";
import { cleanContentType, cleanName, hashCapability, multipartPartCount, multipartPartLength, presentedCapability, redactedState, singleRange } from "../src/core";

describe("share core", () => {
  it("normalizes public file names", () => {
    expect(cleanName("../report\u0000/final.csv")).toBe("..-report-final.csv");
  });

  it("accepts safe content types and rejects malformed metadata", () => {
    expect(cleanContentType("video/mp4")).toBe("video/mp4");
    expect(cleanContentType("text/plain\r\nx-bad: yes")).toBe("application/octet-stream");
  });

  it("plans R2 multipart chunks", () => {
    const part = 16 * 1024 * 1024;
    expect(multipartPartCount(part + 7, part)).toBe(2);
    expect(multipartPartLength(part + 7, part, 1)).toBe(part);
    expect(multipartPartLength(part + 7, part, 2)).toBe(7);
  });

  it("normalizes supported download ranges", () => {
    expect(singleRange("bytes=8-", 11)).toEqual({ offset: 8, length: 3 });
    expect(singleRange("bytes=3-7", 11)).toEqual({ offset: 3, length: 5 });
    expect(singleRange("bytes=-4", 11)).toBeNull();
    expect(singleRange("bytes=11-", 11)).toBeNull();
  });

  it("accepts only explicit capability authorization headers", () => {
    const capability = "a".repeat(43);
    expect(presentedCapability(new Request("https://test", { headers: { authorization: `ShareCapability ${capability}` } }))).toBe(capability);
    expect(presentedCapability(new Request("https://test", { headers: { authorization: `Bearer ${capability}` } }))).toBeNull();
  });

  it("hashes capabilities and removes authority fields", async () => {
    expect(await hashCapability("a")).toHaveLength(64);
    const safe = redactedState({ id: "id", key: "secret", readHash: "read", manageHash: "manage", parts: [], uploadId: "upload", reservedBytes: 1, downloadBudget: 2 });
    expect(safe).toEqual({ id: "id" });
  });
});
