# StorySharp

StorySharp is a local-first browser tool for inspecting and preparing a single photo or video for an Instagram Story. It reports the actual source dimensions and size, flags dimensions and aspect-ratio issues, and lets you download a portrait export.

## Run locally

- `npm install`
- `npm run dev` to start the development server
- `npm run lint` for ESLint
- `npm run typecheck` for TypeScript
- `npm test` for unit tests
- `npm run test:e2e` for Playwright (install browser binaries with `npx playwright install chromium`)
- `npm run build` for a production build

## Privacy and processing

The selected media is read and processed in the browser. It is not uploaded to an application server, saved to a database, or sent to analytics. Video encoding is lazy-loaded when the user starts an encode. The FFmpeg JavaScript module and same-origin worker are emitted by the app build; the single-thread WebAssembly core is fetched from the unpkg CDN on demand. Only engine assets are fetched, never the user's media. An offline deployment should self-host the matching `@ffmpeg/core` assets and update `src/lib/video-optimizer.ts` accordingly.

Image inspection uses `createImageBitmap`; image export uses canvas with high-quality resampling. Video inspection uses browser metadata decoding. Video export uses the FFmpeg.wasm single-thread core, H.264 (`libx264`), AAC, yuv420p, and fast-start MP4. The engine runs away from the UI thread. Its progress events drive the progress display and the job can be terminated. The first video task may take longer while the engine downloads.

## Supported inputs and limits

- Images: signature-checked JPEG, PNG, and WebP that the browser can decode
- Videos: signature-checked MP4, MOV, and WebM containers that the browser can decode and FFmpeg.wasm can transcode
- One media file at a time; configured maximum input size is 250 MB
- Recommended Story canvas: 1080 × 1920 (9:16); output is not guaranteed to match Instagram's internal processing

Browsers differ in codec support, available memory, and WebAssembly speed. FFmpeg.wasm can be much slower than native FFmpeg and may fail for large inputs, especially on mobile devices. A recognized container does not guarantee that its particular codec is available. Unsupported files are reported; no fake output is generated. Video properties not exposed by browser metadata (such as codec, bit depth, measured bitrate, variable-frame-rate status, HDR/color metadata, and rotation metadata) are shown as unknown or omitted.

## Quality and limitations

Image resizing and JPEG export can be lossy. Video is transcoded using a quality-targeted CRF setting; final bitrate and size depend on the content. No lossy operation is promised to be lossless. The Balanced, Maximum quality, and Smaller file controls select CRF/encoder preset mappings for video. Images use the selected JPEG quality. Fit preserves the full frame with letterboxing, Crop can discard edges, and Soft fill uses a blurred background. Image output includes a before/after slider. Crop preview reflects the selected framing. HDR conversion, variable-frame-rate normalization, target-size retry passes, face-aware crop, configurable output resolution/frame rate, and mobile device capability estimates are not implemented. A bitrate estimate helper is provided, but strict target-size encoding is not exposed in this MVP. Audio is encoded as AAC when present; the current UI does not offer a mute option. Compatible images are offered as originals to avoid needless conversion.

Output is re-opened by the browser for metadata verification before the download link appears. Actual file byte counts are used for before/after size comparisons. The local preview is not a simulation of Instagram's rendering.

## Licenses

Review Next.js, React, FFmpeg.wasm, and the FFmpeg core distribution licenses before distributing a deployment. This project uses `@ffmpeg/core`'s single-thread WebAssembly distribution; deployments should confirm the exact FFmpeg build configuration and any codec-library obligations applicable to their distribution.
