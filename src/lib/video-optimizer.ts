import type { FFmpeg as FFmpegInstance } from "@ffmpeg/ffmpeg";
import { presetOptions, type Preset } from "./media";

export type VideoOptions = { preset: Preset; fit: "fit" | "crop" | "blur"; fps: number | "preserve"; muted: boolean };
export type VideoJob = { blob: Blob; name: string; width: number; height: number; duration: number; format: string };

const CORE_VERSION = "0.12.10";
const WORKER_IDLE_TIMEOUT_MS = 60_000;

type EngineSource = {
  base: string;
  files: string[];
};

const MT_SOURCES: EngineSource[] = [
  { base: "/ffmpeg-mt", files: ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"] },
  { base: `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/umd`, files: ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"] },
  { base: `https://unpkg.com/@ffmpeg/core-mt@${CORE_VERSION}/dist/umd`, files: ["ffmpeg-core.js", "ffmpeg-core.wasm", "ffmpeg-core.worker.js"] },
];

const ST_SOURCES: EngineSource[] = [
  { base: "/ffmpeg", files: ["ffmpeg-core.js", "ffmpeg-core.wasm"] },
  { base: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`, files: ["ffmpeg-core.js", "ffmpeg-core.wasm"] },
  { base: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`, files: ["ffmpeg-core.js", "ffmpeg-core.wasm"] },
];

let ffmpegInstance: FFmpegInstance | null = null;
let ffmpegLoading: Promise<FFmpegInstance> | null = null;
let activeWorkerBlobUrl: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let conversionActive = false;

function cancelled(): DOMException { return new DOMException("Processing cancelled", "AbortError"); }

function cleanupWorkerBlob() {
  if (activeWorkerBlobUrl) {
    URL.revokeObjectURL(activeWorkerBlobUrl);
    activeWorkerBlobUrl = null;
  }
}

async function fetchBlobWithCache(url: string, signal: AbortSignal, isLocal: boolean): Promise<Blob> {
  if (isLocal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Engine file not found: ${url} (${res.status})`);
    return await res.blob();
  }
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open("ffmpeg-core-cache-v1");
      const matched = await cache.match(url);
      if (matched && matched.ok) {
        return await matched.blob();
      }
      const res = await fetch(url, { signal });
      if (res.ok) {
        cache.put(url, res.clone()).catch(() => {});
        return await res.blob();
      }
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    } catch (e) {
      if (signal.aborted) throw e;
    }
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.blob();
}

async function getFFmpeg(FFmpeg: typeof import("@ffmpeg/ffmpeg").FFmpeg, signal: AbortSignal, onProgress: (value: number) => void): Promise<FFmpegInstance> {
  if (signal.aborted) throw cancelled();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;

  const loadEngine = async (multithreaded: boolean): Promise<FFmpegInstance> => {
    const ffmpeg = new FFmpeg();
    ffmpegInstance = ffmpeg;
    let coreBlob = "";
    let wasmBlob = "";
    let workerBlob = "";
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const sources = multithreaded ? MT_SOURCES : ST_SOURCES;

    try {
      let blobs: Blob[] | undefined;
      let lastErr: unknown;

      for (const src of sources) {
        try {
          const isLocal = src.base.startsWith("/");
          const controller = new AbortController();
          const timeoutMs = isLocal ? 8_000 : 60_000;
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const abort = () => controller.abort();
          signal.addEventListener("abort", abort, { once: true });

          try {
            blobs = await Promise.all(
              src.files.map((file) =>
                fetchBlobWithCache(`${src.base}/${file}`, controller.signal, isLocal)
              )
            );
            break;
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          }
        } catch (err) {
          lastErr = err;
          if (signal.aborted) throw cancelled();
        }
      }

      if (!blobs) {
        throw lastErr instanceof Error ? lastErr : new Error("The video engine could not be downloaded.");
      }

      onProgress(3);
      coreBlob = URL.createObjectURL(new Blob([blobs[0]], { type: "text/javascript" }));
      wasmBlob = URL.createObjectURL(new Blob([blobs[1]], { type: "application/wasm" }));
      if (multithreaded && blobs[2]) {
        workerBlob = URL.createObjectURL(new Blob([blobs[2]], { type: "text/javascript" }));
        activeWorkerBlobUrl = workerBlob;
      }

      await Promise.race([
        ffmpeg.load(
          {
            coreURL: coreBlob,
            wasmURL: wasmBlob,
            ...(workerBlob ? { workerURL: workerBlob } : {}),
          },
          { signal }
        ),
        new Promise<never>((_, reject) => {
          loadTimer = setTimeout(
            () => reject(new Error("The video engine did not start in time.")),
            multithreaded ? 15_000 : 45_000
          );
        }),
      ]);

      if (signal.aborted) throw cancelled();
      onProgress(5);
      return ffmpeg;
    } catch (error) {
      ffmpeg.terminate();
      if (workerBlob) {
        URL.revokeObjectURL(workerBlob);
        if (activeWorkerBlobUrl === workerBlob) activeWorkerBlobUrl = null;
      }
      if (ffmpegInstance === ffmpeg) ffmpegInstance = null;
      throw error;
    } finally {
      if (loadTimer) clearTimeout(loadTimer);
      if (coreBlob) URL.revokeObjectURL(coreBlob);
      if (wasmBlob) URL.revokeObjectURL(wasmBlob);
    }
  };

  let loading!: Promise<FFmpegInstance>;
  loading = (async () => {
    const canMT = false;
    if (canMT) {
      try {
        return await loadEngine(true);
      } catch (err) {
        if (signal.aborted) throw cancelled();
        console.warn("Multi-threaded video engine failed to start; using compatible single-threaded engine.", err);
      }
    }
    return await loadEngine(false);
  })().finally(() => {
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
    cleanupWorkerBlob();
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
  let lastErrorMessage = "";

  const onEncodeProgress = ({ progress }: { progress: number }) => onProgress(Math.max(5, Math.min(98, Math.round(progress * 100))));
  const onEncodeLog = ({ message }: { message: string }) => {
    if (!/AVOption b|deprecated/i.test(message) && /error|failed|invalid|not found/i.test(message)) {
      lastErrorMessage = message;
      console.warn("FFmpeg:", message.slice(0, 180));
    }
  };

  const inputName = file.name.toLowerCase().endsWith(".webm") ? "source.webm" : "source.mp4";
  const inputPath = `/input/${inputName}`;

  try {
    const { FFmpeg, FFFSType } = await import("@ffmpeg/ffmpeg");
    onProgress(2);
    ffmpeg = await getFFmpeg(FFmpeg, signal, onProgress);
    if (signal.aborted) throw cancelled();

    abort = () => {
      ffmpeg?.terminate();
      cleanupWorkerBlob();
      if (ffmpegInstance === ffmpeg) ffmpegInstance = null;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    signal.addEventListener("abort", abort, { once: true });
    ffmpeg.on("progress", onEncodeProgress);
    ffmpeg.on("log", onEncodeLog);

    // Clean up any remnants from previous operations before mounting
    await ffmpeg.unmount("/input").catch(() => false);
    await ffmpeg.deleteDir("/input").catch(() => false);
    await ffmpeg.deleteFile("/result.mp4").catch(() => false);

    // WORKERFS reads the original File in the worker without copying the full
    // video into a second in-memory Uint8Array.
    await ffmpeg.createDir("/input").catch(() => false);
    inputDirectoryCreated = true;
    await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: inputName, data: file }] }, "/input");
    mounted = true;

    const scale = options.fit === "crop"
      ? "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2:flags=fast_bilinear,crop=1080:1920"
      : "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black";

    // Optimized blur filter: downscales the background stream before applying box blur,
    // reducing pixel processing overhead by >95% while keeping the soft background look.
    const blurFilter = "[0:v]split=2[background][foreground];[background]scale=135:240:force_original_aspect_ratio=increase:force_divisible_by=2:flags=fast_bilinear,crop=135:240,boxblur=8:2,scale=1080:1920:flags=fast_bilinear[bg];[foreground]scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]";

    const args = ["-threads", "0", "-i", inputPath];
    if (options.fit === "blur") {
      args.push("-filter_complex", blurFilter, "-map", "[v]", "-map", "0:a?");
    } else {
      args.push("-vf", `${scale},setsar=1`);
    }

    args.push(
      "-c:v", "libx264",
      "-preset", presetOptions[options.preset].preset,
      "-crf", String(presetOptions[options.preset].crf),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart"
    );

    if (options.fps !== "preserve") args.push("-r", String(options.fps));
    if (options.muted) {
      args.push("-an");
    } else {
      args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
    }
    args.push("-y", "/result.mp4");

    const exitCode = await ffmpeg.exec(args, -1, { signal });
    if (signal.aborted) throw cancelled();

    if (exitCode !== 0) {
      throw new Error(`The encoder failed with code ${exitCode}. ${lastErrorMessage || "Check format and compatibility."}`);
    }

    const data = await ffmpeg.readFile("/result.mp4", undefined, { signal });
    if (typeof data === "string") throw new Error("The encoder returned an invalid file.");
    const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
    if (!blob.size) throw new Error("The encoder produced an empty file.");

    onProgress(100);
    const url = URL.createObjectURL(blob);
    const meta = await new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
      video.onerror = () => reject(new Error("Output file could not be verified."));
      video.src = url;
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
