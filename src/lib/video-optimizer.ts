import type { Preset } from "./media";

export type VideoOptions = { preset: Preset; fit: "fit" | "crop" | "blur"; fps: number | "preserve"; muted: boolean };
export type VideoJob = { blob: Blob; name: string; width: number; height: number; duration: number; format: string };

// FFmpeg.wasm owns a dedicated Web Worker for decode/encode work. Loading is deferred until a video job starts.
export async function transcodeVideo(file: File, options: VideoOptions, onProgress: (value: number) => void, signal: AbortSignal): Promise<VideoJob> {
  // Load the package only on the video path. Webpack emits FFmpeg's module worker
  // as a same-origin asset; importing its ESM directly from a CDN would make the
  // worker cross-origin and browsers would reject it.
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const ffmpeg = new FFmpeg();
  let coreBlob = "";
  let wasmBlob = "";
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { void ffmpeg.terminate(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const base = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
    const [coreResponse, wasmResponse] = await Promise.all([fetch(`${base}/ffmpeg-core.js`, { signal }), fetch(`${base}/ffmpeg-core.wasm`, { signal })]);
    if (!coreResponse.ok || !wasmResponse.ok) throw new Error("The video engine could not be downloaded.");
    coreBlob = URL.createObjectURL(new Blob([await coreResponse.blob()], { type: "text/javascript" }));
    wasmBlob = URL.createObjectURL(new Blob([await wasmResponse.blob()], { type: "application/wasm" }));
    try {
      await Promise.race([
        ffmpeg.load({ coreURL: coreBlob, wasmURL: wasmBlob }, { signal }),
        new Promise<never>((_, reject) => { loadTimer = setTimeout(() => reject(new Error("The video engine did not start within 60 seconds.")), 60_000); }),
      ]);
    } finally { if (loadTimer) clearTimeout(loadTimer); }
    URL.revokeObjectURL(coreBlob); coreBlob = "";
    URL.revokeObjectURL(wasmBlob); wasmBlob = "";
    if (signal.aborted) throw new DOMException("Processing cancelled", "AbortError");
    ffmpeg.on("progress", ({ progress }) => onProgress(Math.max(5, Math.min(98, Math.round(progress * 100)))));
    ffmpeg.on("log", ({ message }) => { if (/error|failed|not found/i.test(message)) console.warn("FFmpeg:", message.slice(0, 180)); });
    const input = "source" + (file.name.toLowerCase().endsWith(".webm") ? ".webm" : ".mp4");
    await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()), { signal });
    const crf = options.preset === "maximum" ? "18" : options.preset === "smaller" ? "28" : "23";
    const scale = options.fit === "crop"
      ? "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=1080:1920"
      : "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black";
    const blurFilter = "[0:v]split=2[background][foreground];[background]scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920,gblur=sigma=28[bg];[foreground]scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]";
    const args = ["-i", input];
    if (options.fit === "blur") args.push("-filter_complex", blurFilter, "-map", "[v]", "-map", "0:a?");
    else args.push("-vf", `${scale},setsar=1`);
    args.push("-c:v", "libx264", "-preset", options.preset === "maximum" ? "slow" : options.preset === "smaller" ? "fast" : "medium", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (options.fps !== "preserve") args.push("-r", String(options.fps));
    if (options.muted) args.push("-an"); else args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
    args.push("-y", "result.mp4");
    await ffmpeg.exec(args, -1, { signal });
    if (signal.aborted) throw new DOMException("Processing cancelled", "AbortError");
    const data = await ffmpeg.readFile("result.mp4", undefined, { signal });
    if (typeof data === "string") throw new Error("The encoder returned an invalid file.");
    const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
    if (!blob.size) throw new Error("The encoder produced an empty file.");
    onProgress(100);
    const url = URL.createObjectURL(blob);
    const meta = await new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
      const video = document.createElement("video"); video.preload = "metadata"; video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration }); video.onerror = () => reject(new Error("Output file could not be verified.")); video.src = url;
    }).finally(() => URL.revokeObjectURL(url));
    return { blob, name: file.name.replace(/\.[^.]+$/, "") + "-storysharp.mp4", ...meta, format: "MP4 · H.264/AAC" };
  } catch (error) {
    if (signal.aborted) throw new DOMException("Processing cancelled", "AbortError");
    throw new Error(error instanceof Error ? `Video processing failed: ${error.message}` : "Video processing failed. Try a smaller or browser-compatible file.");
  } finally {
    signal.removeEventListener("abort", abort);
    if (loadTimer) clearTimeout(loadTimer);
    if (coreBlob) URL.revokeObjectURL(coreBlob);
    if (wasmBlob) URL.revokeObjectURL(wasmBlob);
    ffmpeg.terminate();
  }
}
