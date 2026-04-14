# Rezip

Self-hosted video compression tool powered by FFmpeg + H.265 (HEVC). 100% local; nothing leaves your machine.

## Quick Start

### With Docker (recommended)

```bash
docker compose up --build
```

Then open [http://localhost:3000](http://localhost:3000)

### Without Docker

Requires Node.js 18+ and FFmpeg in PATH.

```bash
npm install
npm start
```

## How It Works

1. Upload any video (MP4, MKV, MOV, AVI, WEBM, etc.)
2. Choose a compression level:
   - **Low** — near-lossless, minor size reduction (CRF 19)
   - **Medium** — balanced quality & size (CRF 25) ← default
   - **High** — maximum compression, ideal for web (CRF 31)
3. Click **Rezip** and watch real-time progress
4. Download your compressed file

## Features

- **H.265/HEVC** encoding for best quality-to-size ratio
- Real-time progress via Server-Sent Events (SSE)
- Automatic cleanup of files after download or 1-hour timeout
- No file size limits (limited only by your disk)
- Zero configuration required

## Architecture

```
Browser → POST /upload (multer) → ffmpeg child_process
                                        ↓ stderr progress
Browser ← GET /status (SSE) ← Express SSE stream
Browser → GET /download/:id → file served + cleanup
```

## Privacy

All processing happens inside the Docker container / local Node process. No external APIs, no cloud, no analytics.
