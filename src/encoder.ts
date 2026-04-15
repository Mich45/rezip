import { execSync } from 'child_process';
import os from 'os';

export type EncoderProfile = {
  encoder: string;
  extraArgs: string[];
  usesBitrate: boolean; // true = -b:v, false = -crf
};

type Platform = 'mac' | 'windows' | 'linux' | 'unknown';
type GPUVendor = 'apple' | 'nvidia' | 'intel' | 'amd' | 'unknown';

function getPlatform(): Platform {
  const p = os.platform();
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'windows';
  if (p === 'linux') return 'linux';
  return 'unknown';
}

function getGPUVendor(): GPUVendor {
  const platform = getPlatform();
  try {
    if (platform === 'mac') {
      const info = execSync('system_profiler SPDisplaysDataType 2>/dev/null', { encoding: 'utf8' });
      if (/apple/i.test(info)) return 'apple';
      if (/nvidia/i.test(info)) return 'nvidia';
      if (/intel/i.test(info)) return 'intel';
      if (/amd|radeon/i.test(info)) return 'amd';
    }

    if (platform === 'linux') {
      const info = execSync('lspci 2>/dev/null || echo ""', { encoding: 'utf8' });
      if (/nvidia/i.test(info)) return 'nvidia';
      if (/intel/i.test(info)) return 'intel';
      if (/amd|radeon/i.test(info)) return 'amd';
    }

    if (platform === 'windows') {
      const info = execSync('wmic path win32_videocontroller get name 2>nul', { encoding: 'utf8' });
      if (/nvidia/i.test(info)) return 'nvidia';
      if (/intel/i.test(info)) return 'intel';
      if (/amd|radeon/i.test(info)) return 'amd';
    }
  } catch {
    // detection failed, fall through to unknown
  }
  return 'unknown';
}

function isEncoderAvailable(encoder: string): boolean {
  try {
    execSync(`ffmpeg -hide_banner -encoders 2>/dev/null | grep ${encoder}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const ENCODER_CANDIDATES: Record<GPUVendor | 'cpu', () => EncoderProfile> = {
  apple: () => ({
    encoder: 'h264_videotoolbox',
    extraArgs: [],
    usesBitrate: true,
  }),
  nvidia: () => ({
    encoder: 'h264_nvenc',
    extraArgs: ['-rc', 'vbr', '-tune', 'hq', '-spatial_aq', '1'],
    usesBitrate: true,
  }),
  intel: () => ({
    encoder: 'h264_qsv',
    extraArgs: ['-look_ahead', '1'],
    usesBitrate: true,
  }),
  amd: () => ({
    encoder: 'h264_amf',
    extraArgs: ['-quality', 'speed'],
    usesBitrate: true,
  }),
  unknown: () => cpuFallback(),
  cpu: () => cpuFallback(),
};

// Fallback to CPU encoding with libx264 ultrafast preset  if GPU is not available or not requested
function cpuFallback(): EncoderProfile {
  return {
    encoder: 'libx264',
    extraArgs: ['-preset', 'ultrafast'],
    usesBitrate: false,
  };
}

export function resolveEncoder(forceGPU: boolean): EncoderProfile {
  const platform = getPlatform();
  const vendor = getGPUVendor();

  console.log(`[encoder] Platform: ${platform}, GPU vendor: ${vendor}, forceGPU: ${forceGPU}`);

  if (!forceGPU) {
    console.log('[encoder] GPU acceleration not requested — using libx264 ultrafast');
    return cpuFallback();
  }

  const candidate = ENCODER_CANDIDATES[vendor]?.() ?? cpuFallback();

  if (isEncoderAvailable(candidate.encoder)) {
    console.log(`[encoder] Using hardware encoder: ${candidate.encoder}`);
    return candidate;
  }

  console.warn(`[encoder] ${candidate.encoder} not available — falling back to libx264 ultrafast`);
  return cpuFallback();
}