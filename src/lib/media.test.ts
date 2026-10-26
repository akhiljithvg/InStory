import { describe, expect, it } from "vitest";
import { aspectRatio, compatibility, compareFileSizes, detectFormat, estimateVideoBitrate, formatBytes, imageNeedsOptimization, outputDimensions, presetOptions, validateFile } from "./media";

describe("media decision helpers", () => {
  it("calculates aspect ratio and caps dimensions without upscaling", () => {
    expect(aspectRatio(1080, 1920)).toBe(0.5625);
    expect(outputDimensions(2160, 3840)).toEqual({ width: 1080, height: 1920 });
    expect(outputDimensions(720, 1280)).toEqual({ width: 720, height: 1280 });
  });
  it("makes encoder dimensions even", () => expect(outputDimensions(1001, 1779)).toEqual({ width: 1000, height: 1778 }));
  it("maps quality presets to distinct CRF targets", () => {
    expect(presetOptions.maximum.crf).toBeLessThan(presetOptions.balanced.crf);
    expect(presetOptions.smaller.crf).toBeGreaterThan(presetOptions.balanced.crf);
  });
  it("reports when a source should be downscaled", () => {
    const issues = compatibility({ kind: "image", name: "a.jpg", type: "image/jpeg", size: 100, width: 2400, height: 3600, format: "JPEG" });
    expect(issues.some((i) => i.title.includes("Dimensions"))).toBe(true);
  });
  it("formats file sizes from actual byte values", () => expect(formatBytes(1048576)).toBe("1.0 MB"));
  it("compares actual source and output sizes", () => {
    expect(compareFileSizes(1000, 700)).toEqual({ difference: 300, percent: 30 });
    expect(compareFileSizes(1000, 1200)).toEqual({ difference: -200, percent: 20 });
  });
  it("estimates video bitrate for a target size after audio and container allowance", () => {
    expect(estimateVideoBitrate(10_000_000, 10, 128_000, 0)).toBe(7_872_000);
    expect(() => estimateVideoBitrate(100, 0)).toThrow("positive");
  });
  it("identifies image resizing and conversion decisions", () => {
    expect(imageNeedsOptimization({ kind: "image", name: "x.webp", type: "image/webp", size: 200, width: 1200, height: 2000, format: "WebP" })).toBe(true);
    expect(imageNeedsOptimization({ kind: "image", name: "x.png", type: "image/png", size: 200, width: 1080, height: 1920, format: "PNG" })).toBe(false);
  });
  it("validates recognized file signatures, not extension alone", async () => {
    const good = new File([new Uint8Array([0xff, 0xd8, 0xff, 0])], "picture.jpg");
    const wrong = new File(["not an image"], "picture.jpg");
    expect(await detectFormat(good)).toBe("JPEG");
    await expect(validateFile(wrong)).rejects.toThrow("couldn't identify");
  });
});
