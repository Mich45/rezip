const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

async function checkDependencies() {
  const { execSync } = require('child_process');
  const missing = [];
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try { execSync(`which ${bin}`, { stdio: 'ignore' }); }
    catch { missing.push(bin); }
  }
  if (missing.length) {
    console.error(`\n Missing required binaries: ${missing.join(', ')}`);
    console.error('Please install FFmpeg or use the Docker image (it bundles them automatically).\n');
    process.exit(1);
  }
  console.log('FFmpeg and ffprobe found. \n Ready to process videos.');
}

checkDependencies();

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// CRF map
const CRF_MAP = {
  low: 19,
  medium: 25,
  high: 31,
};

// In-memory job store: id -> { status, progress, inputPath, outputPath, filename, error }
const jobs = {};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `input_${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10GB limit

app.use(express.static(path.join(__dirname, 'public')));

// POST /upload
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const quality = req.body.quality || 'medium';
  const crf = CRF_MAP[quality] ?? 25;
  const jobId = uuidv4();
  const inputPath = req.file.path;
  const outputFilename = `rezip_${jobId}.mp4`;
  const outputPath = path.join(UPLOADS_DIR, outputFilename);

  jobs[jobId] = {
    status: 'processing',
    progress: 0,
    inputPath,
    outputPath,
    filename: `rezip_${path.basename(req.file.originalname, path.extname(req.file.originalname))}.mp4`,
    error: null,
  };

  // Schedule cleanup after 1 hour
  setTimeout(() => cleanupJob(jobId), 60 * 60 * 1000);

  // Get duration first with ffprobe
  const ffprobe = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ]);

  let durationStr = '';
  ffprobe.stdout.on('data', d => (durationStr += d.toString()));
  ffprobe.on('close', () => {
    const totalSeconds = parseFloat(durationStr.trim()) || 0;

    const args = [
      '-i', inputPath,
      '-c:v', 'libx265',
      '-crf', String(crf),
      '-preset', 'medium',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-tag:v', 'hvc1',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      '-y',
      outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', args);

    let stderrBuf = '';
    ffmpeg.stderr.on('data', chunk => {
      stderrBuf += chunk.toString();
      // Parse progress lines
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const ms = parseInt(line.split('=')[1], 10);
          if (totalSeconds > 0 && ms > 0) {
            const pct = Math.min(99, Math.round((ms / 1000000 / totalSeconds) * 100));
            jobs[jobId].progress = pct;
          }
        }
      }
    });

    ffmpeg.on('close', code => {
      if (code === 0) {
        jobs[jobId].status = 'done';
        jobs[jobId].progress = 100;
      } else {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'FFmpeg process failed. Unsupported format or corrupted file.';
        cleanupJob(jobId);
      }
    });

    ffmpeg.on('error', err => {
      jobs[jobId].status = 'error';
      jobs[jobId].error = 'FFmpeg not found. Ensure it is installed in PATH.';
    });
  });

  res.json({ jobId });
});

// GET /status?id=...  (SSE)
app.get('/status', (req, res) => {
  const { id } = req.query;
  const job = jobs[id];
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    const j = jobs[id];
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
app.get('/download/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'File not ready.' });

  res.download(job.outputPath, job.filename, err => {
    if (!err) {
      // Clean up after successful download
      setTimeout(() => cleanupJob(req.params.id), 5000);
    }
  });
});

function cleanupJob(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  [job.inputPath, job.outputPath].forEach(p => {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
  delete jobs[jobId];
}

app.listen(PORT, () => console.log(`Rezip running on http://localhost:${PORT}`));
