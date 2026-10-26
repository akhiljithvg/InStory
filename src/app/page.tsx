"use client";
/* eslint-disable @next/next/no-img-element -- local object URLs must bypass Next's remote image optimizer. */

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, CheckCircle2, ChevronDown, CircleHelp, Clapperboard, FileImage, FileVideo, Gauge, LockKeyhole, Maximize2, Plus, Settings2, ShieldCheck, Sparkles, Upload, X } from "lucide-react";
import { compatibility, compareFileSizes, formatBytes, imageNeedsOptimization, inspectImage, inspectVideo, MediaInfo, optimizeImage, Preset, presetOptions, validateFile } from "@/lib/media";
import { transcodeVideo } from "@/lib/video-optimizer";

type Output = { blob: Blob; name: string; width: number; height: number; format: string };
function safeBaseName(name: string) { return (name.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 90) || "storysharp-export"); }
function ratioLabel(width: number, height: number) { let a = width, b = height; while (b) [a, b] = [b, a % b]; return a ? `${width / a}:${height / a}` : "Unknown"; }

export default function Home() {
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [preview, setPreview] = useState("");
  const [outputUrl, setOutputUrl] = useState("");
  const [output, setOutput] = useState<Output | null>(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"idle" | "inspecting" | "ready" | "processing" | "done">("idle");
  const [progress, setProgress] = useState(0);
  const [preset, setPreset] = useState<Preset>("balanced");
  const [fit, setFit] = useState<"fit" | "crop" | "blur">("fit");
  const [quality, setQuality] = useState(90);
  const [advanced, setAdvanced] = useState(false);
  const [showAfter, setShowAfter] = useState(true);
  const [comparison, setComparison] = useState(50);
  const [processingSeconds, setProcessingSeconds] = useState<number | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); if (outputUrl) URL.revokeObjectURL(outputUrl); aborter.current?.abort(); }, [preview, outputUrl]);

  async function selectFile(candidate?: File) {
    if (!candidate) return;
    setError(""); setStage("inspecting"); setOutput(null); setProgress(0);
    setFile(null); setInfo(null); setPreview(""); setComparison(50);
    if (preview) URL.revokeObjectURL(preview); if (outputUrl) URL.revokeObjectURL(outputUrl); setOutputUrl("");
    try {
      const { format, kind } = await validateFile(candidate);
      const result = kind === "image" ? await inspectImage(candidate, format) : await inspectVideo(candidate, format);
      setFile(candidate); setInfo(result); setPreview(URL.createObjectURL(candidate)); setStage("ready");
    } catch (e) { setFile(null); setInfo(null); setStage("idle"); setError(e instanceof Error ? e.message : "This file could not be inspected."); }
  }
  function onPicker(e: ChangeEvent<HTMLInputElement>) { void selectFile(e.target.files?.[0]); e.target.value = ""; }
  function onDrop(e: DragEvent) { e.preventDefault(); setDragging(false); void selectFile(e.dataTransfer.files?.[0]); }
  function reset() { aborter.current?.abort(); setFile(null); setInfo(null); setOutput(null); setStage("idle"); setProgress(0); setError(""); setShowAfter(true); setComparison(50); if (preview) URL.revokeObjectURL(preview); if (outputUrl) URL.revokeObjectURL(outputUrl); setPreview(""); setOutputUrl(""); }
  async function optimize() {
    if (!file || !info) return;
    const eligible = info.kind === "image" && info.width <= 1080 && info.height <= 1920 && info.format !== "WebP" && info.size <= 15 * 1024 * 1024 && Math.abs(info.width / info.height - 9 / 16) <= .03;
    if (eligible) { setError("This file already fits the recommended profile. Keep the original to avoid unnecessary quality loss."); return; }
    aborter.current = new AbortController(); setStage("processing"); setProgress(1); setError(""); setProcessingSeconds(null);
    const startedAt = performance.now();
    try {
      let result: Output;
      if (info.kind === "image") {
        const blob = await optimizeImage(file, info.format, fit, quality, setProgress);
        result = { blob, name: safeBaseName(file.name) + (blob.type === "image/png" ? "-storysharp.png" : "-storysharp.jpg"), width: 1080, height: 1920, format: blob.type === "image/png" ? "PNG" : "JPEG" };
                } else {
        const v = await transcodeVideo(file, { preset, fit, fps: "preserve", muted: false }, setProgress, aborter.current.signal);
        result = { ...v, name: `${safeBaseName(file.name)}-storysharp.mp4` };
      }
      setProcessingSeconds((performance.now() - startedAt) / 1000); setOutput(result); setOutputUrl(URL.createObjectURL(result.blob)); setStage("done");
    } catch (e) { if (e instanceof Error && e.name === "AbortError") { setStage("ready"); setError("Processing was cancelled. You can try again."); } else { setStage("ready"); setError(e instanceof Error ? e.message : "Processing failed. Try again with a smaller file."); } }
    finally { aborter.current = null; }
  }

  const issues = info ? compatibility(info) : [];
  const dims = info && output ? `${info.width} × ${info.height}` : info ? `${info.width} × ${info.height}` : "—";
  const warnings = issues.some((issue) => issue.severity === "warning");
  const compatibilityStatus = info?.kind === "video" ? "Review required" : warnings ? "Needs optimization" : "Ready";
  const canKeepOriginal = info?.kind === "image" && !imageNeedsOptimization(info);
  const jpegQualityApplies = info?.kind === "image" && (info.format !== "PNG" || info.size >= 5_000_000);
  const overallBitrate = info?.kind === "video" && info.duration && Number.isFinite(info.duration) ? `${((info.size * 8 / info.duration) / 1_000_000).toFixed(1)} Mbps · overall` : "Unknown";
  const saving = file && output ? file.size - output.blob.size : 0;
  const changePercent = file && output ? compareFileSizes(file.size, output.blob.size).percent : 0;
  const sizeSummary = saving > 0 ? `${formatBytes(saving)} smaller (${changePercent}%).` : saving < 0 ? `${formatBytes(-saving)} larger (${changePercent}%).` : "The output is the same size as the original.";

  return <main className="app-shell">
    <header className="topbar"><a href="#top" className="brand"><span className="brand-mark"><Sparkles size={17} strokeWidth={2.2}/></span><span>storysharp</span></a><nav><a href="#how">How it works</a><a href="#faq">FAQ</a><span className="privacy-chip"><LockKeyhole size={13}/> Private by design</span></nav></header>
    <div className="main-wrap" id="top">
      <section className="intro"><div className="eyebrow"><span className="live-dot"/> MADE FOR INSTAGRAM STORIES</div><h1>Your Stories.<br/><span>Ready in Full Quality.</span></h1><p className="lede">Check and prepare your photos and videos for Stories. Make the right adjustments before Instagram gets them.</p></section>

      <section className={`upload-card ${dragging ? "is-dragging" : ""}`} onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { e.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={(e) => { dragDepth.current = 0; onDrop(e); }} aria-label="Upload media">
        <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm" onChange={onPicker} hidden/>
        {!info ? <div className="upload-content">
          <div className="upload-icon"><Upload size={22}/></div><h2>{stage === "inspecting" ? "Checking your file…" : "Drop a photo or video here"}</h2><p>or choose one from your device</p><button className="button primary" onClick={() => picker.current?.click()} disabled={stage === "inspecting"}><Plus size={16}/> Browse files</button><div className="file-allow"><span><FileImage size={14}/> JPG, PNG, WebP</span><i/><span><FileVideo size={14}/> MP4, MOV, WebM</span><i/><span>Up to 250 MB</span></div></div>
          : <div className="workspace"><div className="workspace-head"><div><div className="eyebrow">OPTIMIZATION WORKSPACE</div><h2>{file?.name}</h2><div className="file-sub">{info?.format} <i/> {formatBytes(info?.size ?? 0)} <i/> {info?.kind === "video" ? `${info.duration?.toFixed(1)} sec` : "Image"}</div></div><button className="icon-button" onClick={reset} aria-label="Remove file"><X size={18}/></button></div>
            <div className="workspace-grid"><div className="preview-column"><div className="preview-label"><span>{stage === "done" ? "LOCAL PREVIEW" : "STORY FRAME PREVIEW"}</span>{stage === "done" && info?.kind === "image" && <label className="comparison-control"><span>BEFORE / AFTER</span><input aria-label="Before and after comparison" type="range" min="0" max="100" value={comparison} onChange={(e) => setComparison(Number(e.target.value))}/></label>}{stage === "done" && info?.kind === "video" && <div className="toggle"><button className={!showAfter ? "selected" : ""} onClick={() => setShowAfter(false)}>Original</button><button className={showAfter ? "selected" : ""} onClick={() => setShowAfter(true)}>Optimized</button></div>}</div><div className="story-stage"><div className="story-frame">{info?.kind === "image" && stage === "done" && output ? <div className="comparison-image"><img className={fit === "crop" ? "media-crop" : ""} src={preview} alt="Original image"/><img className="after-image" style={{ clipPath: `inset(0 ${100 - comparison}% 0 0)` }} src={outputUrl} alt="Optimized image"/><span style={{ left: `${comparison}%` }} className="comparison-divider"/></div> : info?.kind === "image" ? <img className={fit === "crop" && stage !== "done" ? "media-crop" : ""} src={preview} alt="Original media preview"/> : <video className={fit === "crop" && (stage !== "done" || !showAfter) ? "media-crop" : ""} src={stage === "done" && showAfter ? outputUrl : preview} controls playsInline/>}<div className="story-top"><span>●  Your story</span><span>···</span></div></div></div>
              <div className="preview-stats"><div><span>ORIGINAL</span><b>{dims}</b><small>{formatBytes(info?.size ?? 0)}</small></div><ArrowRight size={15}/><div><span>{output ? "OPTIMIZED" : "TARGET CANVAS"}</span><b>{output ? `${output.width} × ${output.height}` : "1080 × 1920"}</b><small>{output ? formatBytes(output.blob.size) : "9:16 · sRGB"}</small></div></div></div>
              <aside className="details-column"><div className="panel-title"><Gauge size={16}/> Media inspection</div><div className="meta-grid"><div><span>FORMAT</span><b>{info?.format}</b></div><div><span>TYPE</span><b>{info?.kind === "video" ? "Video" : "Image"}</b></div><div><span>DIMENSIONS</span><b>{dims}</b></div><div><span>ASPECT RATIO</span><b>{info ? ratioLabel(info.width, info.height) : "Unknown"}</b></div>{info?.kind === "video" && <><div><span>DURATION</span><b>{info.duration?.toFixed(1)} sec</b></div><div><span>VIDEO CODEC</span><b>Unknown</b></div><div><span>OVERALL BITRATE</span><b>{overallBitrate}</b></div><div><span>AUDIO CODEC</span><b>Unknown</b></div></>}</div>
                <div className="report"><div className="report-heading"><div className="panel-title"><ShieldCheck size={16}/> Compatibility report</div><span className={`compatibility-badge ${warnings ? "warning" : "good"}`}>{compatibilityStatus}</span></div>{issues.map((issue) => <div className={`issue ${issue.severity}`} key={issue.title}><span className="status-icon">{issue.severity === "good" ? <CheckCircle2 size={16}/> : <CircleHelp size={16}/>}</span><div><b>{issue.title}</b><p>{issue.detail}</p>{issue.tradeoff && <p className="issue-tradeoff">{issue.tradeoff}</p>}</div></div>)}</div>
                <div className="settings"><div className="settings-top"><div className="panel-title"><Settings2 size={16}/> Export settings</div><button className="text-button" onClick={() => setAdvanced(!advanced)}>{advanced ? "Less" : "Advanced"}<ChevronDown size={14} className={advanced ? "rotate" : ""}/></button></div>{info?.kind === "video" ? <><label className="field-label" htmlFor="preset">VIDEO QUALITY PRESET</label><select id="preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}><option value="maximum">Maximum quality</option><option value="balanced">Balanced · Recommended</option><option value="smaller">Smaller file</option></select><p className="field-hint">{presetOptions[preset].description}</p></> : <><label className="field-label" htmlFor="quality">JPEG QUALITY <b>{quality}%</b></label><input id="quality" type="range" min="70" max="100" value={quality} disabled={!jpegQualityApplies} onChange={(e) => setQuality(Number(e.target.value))}/><p className="field-hint">{jpegQualityApplies ? "Higher values preserve more detail and usually make larger files." : "PNG output keeps transparency; JPEG quality does not apply."}</p></>}
                  <label className="field-label">FIT TO PORTRAIT CANVAS</label><div className="segmented three"><button className={fit === "fit" ? "on" : ""} onClick={() => setFit("fit")}><Maximize2 size={13}/> Fit</button><button className={fit === "crop" ? "on" : ""} onClick={() => setFit("crop")}><Clapperboard size={13}/> Crop</button><button className={fit === "blur" ? "on" : ""} onClick={() => setFit("blur")}><Sparkles size={13}/> Soft fill</button></div>{fit === "crop" && <p className="field-hint warn">Crop may remove edges. The preview reflects the selected crop.</p>}{fit === "blur" && <p className="field-hint">Fills unused portrait space with a softly blurred version of the image.</p>}
                  {advanced && <div className="advanced-fields">{info?.kind === "video" ? <><div className="readonly-field"><span>VIDEO OUTPUT</span><b>MP4 · H.264 · AAC · 1080 × 1920</b></div><p className="field-hint">CRF {presetOptions[preset].crf} · Frame rate is preserved. CRF targets quality; output bitrate varies with content.</p></> : <div className="readonly-field"><span>IMAGE OUTPUT</span><b>{info?.format === "PNG" && info.size < 5_000_000 ? "PNG · transparency preserved" : "JPEG · sRGB canvas"}</b></div>}</div>}
                </div>
                {error && <div className="error-message" role="alert"><CircleHelp size={16}/><span>{error}</span></div>}
                {stage === "processing" ? <div className="progress-wrap"><div className="progress-heading"><span>Processing locally</span><b>{progress}%</b></div><div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div><p>{info?.kind === "video" ? "Loading the video engine or encoding on this device. This can take a while." : "Resizing and encoding your image…"}</p><button className="button secondary full" onClick={() => aborter.current?.abort()}>Cancel processing</button></div>
                  : stage === "done" && output ? <div className="complete-card"><div className="success-heading"><CheckCircle2 size={18}/> Optimization complete</div><div className="complete-facts"><span>{output.name}</span><b>{output.width} × {output.height} · {output.format} · {formatBytes(output.blob.size)}</b></div><p>{sizeSummary} {info?.kind === "video" ? "H.264 encoding may reduce fine detail." : "This output was encoded locally."} Processing took {processingSeconds?.toFixed(1)} sec.</p><a className="button primary full" href={outputUrl} download={output.name}><ArrowDownToLine size={16}/> Download optimized file</a><button className="button secondary full another" onClick={reset}>Optimize another file</button></div>
                  : canKeepOriginal ? <a className="button secondary full" href={preview} download={file?.name}><ArrowDownToLine size={16}/> Keep original · already Story-ready</a>
                  : <button className="button primary full" onClick={() => void optimize()} disabled={stage !== "ready"}><Sparkles size={16}/>{info?.kind === "video" ? "Convert video to H.264" : "Optimize for Stories"}</button>}
                <div className="privacy-note"><LockKeyhole size={14}/> Your file stays on this device. Nothing is uploaded.</div>
              </aside></div>
          </div>}
      </section>
      {!info && error && <div className="error-message outside" role="alert"><CircleHelp size={16}/><span>{error}</span></div>}
      {!info && <div className="safe-note"><ShieldCheck size={15}/> Your media never leaves your device. Processing happens in your browser.</div>}

      <section className="how-section" id="how"><div className="section-heading"><div className="eyebrow">THREE STEPS, NO SURPRISES</div><h2>Quality in your hands.</h2></div><div className="steps"><article><span>01</span><Upload size={19}/><h3>Upload</h3><p>Choose one photo or video from your device.</p></article><article><span>02</span><Settings2 size={19}/><h3>Review & optimize</h3><p>See what may need adjusting, then choose your quality.</p></article><article><span>03</span><ArrowDownToLine size={19}/><h3>Download</h3><p>Get a ready-to-upload file and a clear change summary.</p></article></div></section>
      <section className="faq" id="faq"><div className="faq-intro"><div className="eyebrow">A FEW GOOD QUESTIONS</div><h2>Made to be clear.</h2><p>No mystery settings or quality guarantees. Just an honest look at what your file needs.</p></div><div className="faq-list"><details><summary>Will my story look exactly the same on Instagram?</summary><p>No one can predict Instagram’s internal compression. StorySharp prepares files using a compatible profile, but the platform may still resize and re-encode them.</p></details><details><summary>Does optimization reduce quality?</summary><p>Image resizing and JPEG conversion can be lossy. Video conversion uses H.264 with a quality-targeted setting; it can soften fine details. Keep the original when it already fits your needs.</p></details><details><summary>Are my files uploaded anywhere?</summary><p>No. Inspection and processing run locally in this browser. The video engine is downloaded on demand; your media stays on your device.</p></details><details><summary>Can every browser process every video?</summary><p>No. Browser codecs and device memory vary. FFmpeg.wasm can be slower and memory-intensive, especially on phones. Files up to 250 MB are accepted, but practical limits depend on your device.</p></details></div></section>
      <footer><a href="#top" className="brand"><span className="brand-mark"><Sparkles size={15}/></span><span>storysharp</span></a><span>Made for Stories. Processed on your device.</span><a href="#faq">Privacy & limitations</a></footer>
    </div>
  </main>;
}
