import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("landing page renders the privacy-first upload workflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Your Stories/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Browse files/i })).toBeVisible();
  await expect(page.getByText(/Your media never leaves your device/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quality in your hands." })).toBeVisible();
});

test("inspects and encodes a real image for the Story canvas", async ({ page }, testInfo) => {
  await page.goto("/");
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 2100;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#6c52ad"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    return await blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)));
  });
  await page.locator('input[type="file"]').setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: Buffer.from(base64) });
  await expect(page.getByText("Dimensions exceed Story canvas")).toBeVisible();
  await page.getByRole("button", { name: "Optimize for Stories" }).click();
  await expect(page.getByText("Optimization complete")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download optimized file" }).click();
  const download = await downloadPromise;
  const destination = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(destination);
  const result = await readFile(destination);
  expect(result.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(result.readUInt32BE(16)).toBe(1080);
  expect(result.readUInt32BE(20)).toBe(1920);
});

test("rejects file content that only claims to be a supported image", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({ name: "fake.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not really a jpeg") });
  await expect(page.getByRole("alert").filter({ hasText: "We couldn't identify" })).toBeVisible();
});

test("transcodes a small browser-created WebM through FFmpeg.wasm", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 180; canvas.height = 320;
    const ctx = canvas.getContext("2d")!; const stream = canvas.captureStream(8);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const parts: BlobPart[] = []; recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start();
    for (let frame = 0; frame < 8; frame++) { ctx.fillStyle = frame % 2 ? "#a970ff" : "#15324f"; ctx.fillRect(0, 0, canvas.width, canvas.height); await new Promise((resolve) => setTimeout(resolve, 100)); }
    recorder.stop(); await stopped; stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(parts, { type: "video/webm" });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('input[type="file"]').setInputFiles({ name: "fixture.webm", mimeType: "video/webm", buffer: Buffer.from(bytes) });
  await expect(page.getByText("Media inspection")).toBeVisible();
  await page.getByRole("button", { name: "Convert video to H.264" }).click();
  await expect(page.getByText("Optimization complete")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText(/MP4 · H\.264\/AAC/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download optimized file" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
});
