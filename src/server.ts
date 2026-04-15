import express, { Request, Response } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import { resolveEncoder } from './encoder';
import { createJob, getJob, updateJob, cleanupJob } from './jobs';

// Config and constants
const PORT = 3000;
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const USE_GPU = process.argv.includes('--gpu')

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Dependency check 
function checkDependencies(): void {
  const missing: string[] = [];
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try { execSync(`which ${bin}`, { stdio: 'ignore' }); }
    catch { missing.push(bin); }
  }
  if (missing.length) {
    console.error(`\n Missing required binaries: ${missing.join(', ')}`);
    console.error('   Install FFmpeg or use the Docker image.\n');
    process.exit(1);
  }
  console.log('Ffmpeg and ffprobe found');
}

checkDependencies();

// Encoder resolution 

const encoderProfile = resolveEncoder(USE_GPU);
console.log(`[server] Encoder: ${encoderProfile.encoder}`);

// Quality map 
type QualityKey = 'low' | 'medium' | 'high';

const QUALITY_MAP: Record<QualityKey, { crf: number; bitrate: string }> = {
  low:    { crf: 19, bitrate: '8000k' },
  medium: { crf: 25, bitrate: '4000k' },
  high:   { crf: 31, bitrate: '1500k' },
};


const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `input_${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage });


const app = express();
app.use(express.static(path.join(process.cwd(), 'public')));

// POST /upload
app.post('/upload', upload.single('video'), (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded.' }); return; }

  const quality = (req.body.quality as QualityKey) ?? 'medium';
  const q = QUALITY_MAP[quality] ?? QUALITY_MAP.medium;
  const jobId = uuidv4();
  const inputPath = req.file.path;
  const outputPath = path.join(UPLOADS_DIR, `rezip_${jobId}.mp4`);

  createJob(jobId, {
    status: 'processing',
    progress: 0,
    inputPath,
    outputPath,
    filename: `rezip_${path.basename(req.file.originalname, path.extname(req.file.originalname))}.mp4`,
    error: null,
  });

  // Get duration via ffprobe, then start ffmpeg
  const ffprobe = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ]);

  let durationStr = '';
  ffprobe.stdout.on('data', (d: Buffer) => (durationStr += d.toString()));

  ffprobe.on('close', () => {
    const totalSeconds = parseFloat(durationStr.trim()) || 0;

    // Build args based on encoder profile
    const videoArgs: string[] = encoderProfile.usesBitrate
      ? ['-c:v', encoderProfile.encoder, '-b:v', q.bitrate, ...encoderProfile.extraArgs]
      : ['-c:v', encoderProfile.encoder, '-crf', String(q.crf), ...encoderProfile.extraArgs];

    const args = [
      '-i', inputPath,
      ...videoArgs,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      '-y',
      outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', args);
    let stderrBuf = '';

    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const ms = parseInt(line.split('=')[1] ?? '0', 10);
          if (totalSeconds > 0 && ms > 0) {
            const pct = Math.min(99, Math.round((ms / 1_000_000 / totalSeconds) * 100));
            updateJob(jobId, { progress: pct });
          }
        }
      }
    });

    ffmpeg.on('close', (code: number | null) => {
      if (code === 0) {
        updateJob(jobId, { status: 'done', progress: 100 });
      } else {
        updateJob(jobId, { status: 'error', error: 'FFmpeg failed. Unsupported format or corrupted file.' });
        cleanupJob(jobId);
      }
    });

    ffmpeg.on('error', () => {
      updateJob(jobId, { status: 'error', error: 'FFmpeg not found in PATH.' });
    });
  });

  res.json({ jobId, encoder: encoderProfile.encoder });
});

// GET /status?id=  (SSE)
app.get('/status', (req: Request, res: Response) => {
  const id = req.query.id as string;
  const job = getJob(id);
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    const j = getJob(id);
    if (!j) { clearInterval(interval); res.end(); return; }
    send({ status: j.status, progress: j.progress, error: j.error });
    if (j.status === 'done' || j.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
});

// GET /download/:id
app.get('/download/:id', (req: Request, res: Response) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'done') { res.status(404).json({ error: 'File not ready.' }); return; }

  res.download(job.outputPath, job.filename, (err) => {
    if (!err) setTimeout(() => cleanupJob(req.params.id), 5000);
  });
});

app.listen(PORT, () => console.log(`Rezip running on http://localhost:${PORT}  [encoder: ${encoderProfile.encoder}]`));