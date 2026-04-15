import fs from 'fs';

export type JobStatus = 'processing' | 'done' | 'error';

export type Job = {
  status: JobStatus;
  progress: number;
  inputPath: string;
  outputPath: string;
  filename: string;
  error: string | null;
};

const jobs = new Map<string, Job>();
const CLEANUP_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export function createJob(id: string, job: Job): void {
  jobs.set(id, job);
  setTimeout(() => cleanupJob(id), CLEANUP_TIMEOUT_MS);
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

export function cleanupJob(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  for (const p of [job.inputPath, job.outputPath]) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
  jobs.delete(id);
}