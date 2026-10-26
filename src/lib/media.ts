export type MediaKind = "image" | "video";
export type MediaInfo = {
  kind: MediaKind;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  duration?: number;
  format: string;
  codec?: string;
};

export const MAX_FILE_BYTES = 250 * 1024 * 1024;
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  webp: (b) => String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP",
  mp4: (b) => String.fromCharCode(...b.slice(4, 8)) === "ftyp",
  webm: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  mov: (b) => String.fromCharCode(...b.slice(4, 8)) === "ftyp",
};

export async function detectFormat(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (SIGNATURES.jpeg(bytes)) return "JPEG";
  if (SIGNATURES.png(bytes)) return "PNG";
  if (SIGNATURES.webp(bytes)) return "WebP";
  if (SIGNATURES.webm(bytes)) return "WebM";
  if (SIGNATURES.mp4(bytes)) return String.fromCharCode(...bytes.slice(8, 12)) === "qt  " ? "MOV" : "MP4";
  return "Unknown";
}

export async function validateFile(file: File): Promise<{ format: string; kind: MediaKind }> {
  if (file.size <= 0) throw new Error("This file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new Error("This file is larger than the 250 MB processing limit.");
  const format = await detectFormat(file);
  if (["JPEG", "PNG", "WebP"].includes(format)) return { format, kind: "image" };
  if (["MP4", "MOV", "WebM"].includes(format)) return { format, kind: "video" };
  throw new Error("We couldn't identify this file as a supported JPEG, PNG, WebP, MP4, MOV, or WebM. The file may be corrupt or use an unsupported codec.");
}

export function aspectRatio(width: number, height: number): number { return height ? width / height : 0; }
export function outputDimensions(width: number, height: number, maxWidth = 1080, maxHeight = 1920) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const even = (n: number) => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(1)} ${units[index]}`;
}
export function compareFileSizes(originalBytes: number, outputBytes: number) {
  const difference = originalBytes - outputBytes;
  return { difference, percent: originalBytes > 0 ? Math.round(Math.abs(difference) / originalBytes * 100) : 0 };
}
export function estimateVideoBitrate(targetBytes: number, durationSeconds: number, audioBitsPerSecond = 192_000, overhead = 0.04) {
  if (!Number.isFinite(targetBytes) || !Number.isFinite(durationSeconds) || targetBytes <= 0 || durationSeconds <= 0 || overhead < 0 || overhead >= 1) throw new Error("Target size and duration must be positive.");
  return Math.max(0, Math.floor(targetBytes * 8 * (1 - overhead) / durationSeconds - audioBitsPerSecond));
}

export async function inspectImage(file: File, format: string): Promise<MediaInfo> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const info = { kind: "image" as const, name: file.name, type: file.type || "Unknown", size: file.size, width: bitmap.width, height: bitmap.height, format };
  bitmap.close();
  return info;
}

export async function inspectVideo(file: File, format: string): Promise<MediaInfo> {
  const url = URL.createObjectURL(file);
  try {
    const meta = await new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
      const video = document.createElement("video"); video.preload = "metadata"; video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration }); video.onerror = () => reject(new Error("The browser could not decode this video. It may use an unsupported codec or be damaged.")); video.src = url;
    });
    return { kind: "video", name: file.name, type: file.type || "Unknown", size: file.size, ...meta, format };
  } finally { URL.revokeObjectURL(url); }
}

export type Preset = "maximum" | "balanced" | "smaller";
export const presetOptions: Record<Preset, { label: string; description: string; crf: number; preset: string }> = {
  maximum: { label: "Maximum quality", description: "Preserve detail; output may be larger.", crf: 18, preset: "slow" },
  balanced: { label: "Balanced", description: "Faster encoding at the same quality target; output may be slightly larger.", crf: 23, preset: "veryfast" },
  smaller: { label: "Smaller file", description: "More compression; fine detail may soften.", crf: 28, preset: "fast" },
};

export function imageNeedsOptimization(info: MediaInfo) {
  return info.width > 1080 || info.height > 1920 || info.format === "WebP" || info.size > 15 * 1024 * 1024 || Math.abs(info.width / info.height - 9 / 16) > .03;
}

export async function optimizeImage(file: File, format: string, mode: "fit" | "crop" | "blur", quality: number, onProgress?: (p: number) => void): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1920;
  const ctx = canvas.getContext("2d"); if (!ctx) { bitmap.close(); throw new Error("This browser cannot create an image canvas."); }
  const scale = mode === "crop" ? Math.max(1080 / bitmap.width, 1920 / bitmap.height) : Math.min(1080 / bitmap.width, 1920 / bitmap.height, 1);
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  if (mode === "blur") {
    const cover = Math.max(1080 / bitmap.width, 1920 / bitmap.height);
    ctx.filter = "blur(26px)";
    ctx.drawImage(bitmap, (1080 - bitmap.width * cover) / 2 - 28, (1920 - bitmap.height * cover) / 2 - 28, bitmap.width * cover + 56, bitmap.height * cover + 56);
    ctx.filter = "none";
    ctx.drawImage(bitmap, (1080 - w) / 2, (1920 - h) / 2, w, h);
  } else {
    if (format !== "PNG") { ctx.fillStyle = "#111216"; ctx.fillRect(0, 0, 1080, 1920); }
    ctx.drawImage(bitmap, (1080 - w) / 2, (1920 - h) / 2, w, h);
  }
  bitmap.close(); onProgress?.(75);
  const type = format === "PNG" && file.size < 5_000_000 ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("The browser couldn't export this image.")), type, quality / 100));
  onProgress?.(100); return blob;
}

export function compatibility(info: MediaInfo) {
  const ratio = info.width / info.height;
  const issues: { title: string; detail: string; severity: "warning" | "good"; tradeoff?: string }[] = [];
  if (info.width < 720 || info.height < 1280) issues.push({ title: "Source resolution is modest", detail: "Upscaling cannot recover missing detail. Fit mode keeps the source pixels at their native scale.", tradeoff: "Optional. Upscaling can soften the image without adding real detail.", severity: "warning" });
  if (info.width > 1080 || info.height > 1920) issues.push({ title: "Dimensions exceed Story canvas", detail: "Downscaling to 1080 × 1920 retains the source framing within the recommended canvas.", tradeoff: "Optional. Downscaling removes pixels; the original file remains available.", severity: "warning" });
  if (Math.abs(ratio - 9 / 16) > 0.03) issues.push({ title: "Aspect ratio differs from 9:16", detail: "Choose Fit to preserve the full frame or Crop to fill the portrait canvas.", tradeoff: "Optional. Fit adds background space; Crop discards edge content.", severity: "warning" });
  if (info.kind === "image" && info.format === "WebP") issues.push({ title: "Image format may be less predictable", detail: "A JPEG export is broadly compatible for photographs.", tradeoff: "Optional. JPEG conversion is lossy; keep the WebP original if preferred.", severity: "warning" });
  if (info.size > (info.kind === "video" ? 50 : 15) * 1024 * 1024) issues.push({ title: "Large source file", detail: "A re-encode may reduce file size, but the result depends on content and quality settings.", tradeoff: "Optional. More compression can reduce fine detail; compare the actual output.", severity: "warning" });
  if (info.kind === "video") issues.push({ title: "Video codec not exposed by browser metadata", detail: "Codec, frame rate, audio properties, and HDR metadata are unknown here. Export can create a known H.264/AAC MP4.", tradeoff: "Optional. H.264 re-encoding is lossy; keep the original if it already uploads correctly.", severity: "warning" });
  if (!issues.length) issues.push({ title: "Ready for Stories", detail: "The source dimensions already fit the recommended portrait canvas. Keep the original if no change is needed.", severity: "good" });
  return issues;
}
