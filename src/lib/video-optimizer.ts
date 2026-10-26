import type { FFmpeg as FFmpegInstance } from "@ffmpeg/ffmpeg";
import { presetOptions, type Preset } from "./media";

export type VideoOptions = { preset: Preset; fit: "fit" | "crop" | "blur"; fps: number | "preserve"; muted: boolean };
export type VideoJob = { blob: Blob; name: string; width: number; height: number; duration: number; format: string };

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
const CORE_MT_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/umd`;
const WORKER_IDLE_TIMEOUT_MS = 60_000;
let ffmpegInstance: FFmpegInstance | null = null;
let ffmpegLoading: Promise<FFmpegInstance> | null = null;
let ffmpegWorkerBlobUrl = "";
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let conversionActive = false;

function cancelled(): DOMException { return new DOMException("Processing cancelled", "AbortError"); }

async function getFFmpeg(FFmpeg: typeof import("@ffmpeg/ffmpeg").FFmpeg, signal: AbortSignal): Promise<FFmpegInstance> {
  if (signal.aborted) throw cancelled();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;

  const ffmpeg = new FFmpeg();
  ffmpegInstance = ffmpeg;
  let coreBlob = "";
  let wasmBlob = "";
  let workerBlob = "";
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let loading!: Promise<FFmpegInstance>;
  loading = (async () => {
    // SharedArrayBuffer is available only on cross-origin-isolated pages. Use
    // FFmpeg's multi-threaded core there; retain the single-thread core fallback.
    const multithreaded = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
    const base = multithreaded ? CORE_MT_BASE : CORE_BASE;
    const files = multithreaded
      ? ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"]
      : ["ffmpeg-core.js", "ffmpeg-core.wasm"];
    const responses = await Promise.all(files.map((name) => fetch(`${base}/${name}`, { signal })));
    if (responses.some((response) => !response.ok)) throw new Error("The video engine could not be downloaded.");
    const [coreResponse, wasmResponse, workerResponse] = responses;
    coreBlob = URL.createObjectURL(new Blob([await coreResponse.blob()], { type: "text/javascript" }));
    wasmBlob = URL.createObjectURL(new Blob([await wasmResponse.blob()], { type: "application/wasm" }));
    if (workerResponse) workerBlob = URL.createObjectURL(new Blob([await workerResponse.blob()], { type: "text/javascript" }));
    await Promise.race([
      ffmpeg.load({ coreURL: coreBlob, wasmURL: wasmBlob, ...(workerBlob ? { workerURL: workerBlob } : {}) }, { signal }),
      new Promise<never>((_, reject) => { loadTimer = setTimeout(() => reject(new Error("The video engine did not start within 60 seconds.")), 60_000); }),
    ]);
    if (signal.aborted) throw cancelled();
    // The core may create pthread workers during later FFmpeg commands, so keep
    // its worker script URL alive until this FFmpeg instance is terminated.
    ffmpegWorkerBlobUrl = workerBlob;
    workerBlob = "";
    return ffmpeg;
  })().catch((error: unknown) => {
    ffmpeg.terminate();
    if (ffmpegWorkerBlobUrl) URL.revokeObjectURL(ffmpegWorkerBlobUrl);
    ffmpegWorkerBlobUrl = "";
    if (ffmpegInstance === ffmpeg) ffmpegInstance = null;
    throw error;
  }).finally(() => {
    if (loadTimer) clearTimeout(loadTimer);
    if (coreBlob) URL.revokeObjectURL(coreBlob);
    if (wasmBlob) URL.revokeObjectURL(wasmBlob);
    if (workerBlob) URL.revokeObjectURL(workerBlob);
    if (ffmpegLoading === loading) ffmpegLoading = null;
  });
  ffmpegLoading = loading;
  return loading;
}

// Keep the loaded worker briefly for a follow-up conversion. It avoids another
// large core download and WebAssembly startup, then releases memory while idle.
function releaseWhenIdle(ffmpeg: FFmpegInstance) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    ffmpeg.terminate();
    if (ffmpegWorkerBlobUrl) URL.revokeObjectURL(ffmpegWorkerBlobUrl);
    ffmpegWorkerBlobUrl = "";
    if (ffmpegInstance === ffmpeg) ffmpegInstance = null;
    idleTimer = undefined;
  }, WORKER_IDLE_TIMEOUT_MS);
}

export async function transcodeVideo(file: File, options: VideoOptions, onProgress: (value: number) => void, signal: AbortSignal): Promise<VideoJob> {
  if (conversionActive) throw new Error("A video is already being processed.");
  conversionActive = true;

  let ffmpeg: FFmpegInstance | null = null;
  let mounted = false;
  let inputDirectoryCreated = false;
  let abort: (() => void) | undefined;
  const onEncodeProgress = ({ progress }: { progress: number }) => onProgress(Math.max(5, Math.min(98, Math.round(progress * 100))));
  const onEncodeLog = ({ message }: { message: string }) => { if (/error|failed|not found/i.test(message)) console.warn("FFmpeg:", message.slice(0, 180)); };
  const inputName = file.name.toLowerCase().endsWith(".webm") ? "source.webm" : "source.mp4";
  const inputPath = `/input/${inputName}`;
  try {
    // Load the package only on the video path. Webpack emits FFmpeg's module
    // worker as a same-origin asset; the core is fetched from the CDN on demand.
    const { FFmpeg, FFFSType } = await import("@ffmpeg/ffmpeg");
    ffmpeg = await getFFmpeg(FFmpeg, signal);
    if (signal.aborted) throw cancelled();

    abort = () => {
      ffmpeg?.terminate();
      if (ffmpegWorkerBlobUrl) URL.revokeObjectURL(ffmpegWorkerBlobUrl);
      ffmpegWorkerBlobUrl = "";
      if (ffmpegInstance === ffmpeg) ffmpegInstance = null;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    signal.addEventListener("abort", abort, { once: true });
    ffmpeg.on("progress", onEncodeProgress);
    ffmpeg.on("log", onEncodeLog);

    // WORKERFS reads the original File in the worker without copying the full
    // video into a second in-memory Uint8Array.
    // Emscripten requires the mount point to exist before mounting a filesystem.
    await ffmpeg.createDir("/input");
    inputDirectoryCreated = true;
    await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: inputName, data: file }] }, "/input");
    mounted = true;

    const scale = options.fit === "crop"
      ? "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2:flags=fast_bilinear,crop=1080:1920"
      : "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black";
    const blurFilter = "[0:v]split=2[background][foreground];[background]scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2:flags=fast_bilinear,crop=1080:1920,gblur=sigma=28[bg];[foreground]scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]";
    const args = ["-i", inputPath];
    if (options.fit === "blur") args.push("-filter_complex", blurFilter, "-map", "[v]", "-map", "0:a?");
    else args.push("-vf", `${scale},setsar=1`);
    args.push("-c:v", "libx264", "-preset", presetOptions[options.preset].preset, "-crf", String(presetOptions[options.preset].crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (options.fps !== "preserve") args.push("-r", String(options.fps));
    if (options.muted) args.push("-an"); else args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
    args.push("-y", "/result.mp4");
    await ffmpeg.exec(args, -1, { signal });
    if (signal.aborted) throw cancelled();

    const data = await ffmpeg.readFile("/result.mp4", undefined, { signal });
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
    if (signal.aborted) throw cancelled();
    const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "Try a smaller or browser-compatible file.";
    throw new Error(`Video processing failed: ${reason}`);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (ffmpeg) {
      ffmpeg.off("progress", onEncodeProgress);
      ffmpeg.off("log", onEncodeLog);
      if (ffmpeg.loaded) {
        if (mounted) await ffmpeg.unmount("/input").catch(() => false);
        if (inputDirectoryCreated) await ffmpeg.deleteDir("/input").catch(() => false);
        await ffmpeg.deleteFile("/result.mp4").catch(() => false);
        releaseWhenIdle(ffmpeg);
      }
    }
    conversionActive = false;
  }
}
