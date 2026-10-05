import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import ffmpegStatic from "ffmpeg-static";
import { decode } from "jpeg-js";

import { SNAPSHOT_DIR } from "./paths";

// Reads the staff gauge in the Pathum Thani municipality's CCTV (Suan Thep Pathum embankment).
// The camera serves an HLS stream of H.264 MPEG-TS segments: we fetch the newest segment, have
// ffmpeg (ffmpeg-static, or FFMPEG_PATH) turn it into JPEG frames, and locate the waterline on
// the yellow staff with simple colour analysis.
//
// The camera is fixed, so pixel -> metres is a one-off calibration against the staff's printed
// marks (ม.รทก.; cross-checked against ThaiWater CPY014 สะพานนวลฉวี, 8 km upstream). If the view
// shifts, the staff-top check fails and we report no reading rather than a wrong one.

const STREAM_BASE = process.env.CCTV_SUANTHEP_BASE ?? "http://101.109.253.60:8999";
const FRAME_W = 640;
const FRAME_H = 480;
const FRAMES_SAMPLED = 9;
const FRAME_STEP = 12; // ~0.5 s apart at 25 fps, so waves average out
const MAX_PLAYLIST_AGE_MS = 15 * 60 * 1000;

// Staff centre line x(y), measured on the 640x480 frame (the staff leans a few px over its height).
const staffCenterX = (y: number) => 298 - ((y - 70) * 9.5) / 288;
const STRIP_HALF_WIDTH = 6;
const STAFF_TOP_RANGE: [number, number] = [58, 78]; // where the yellow staff must start, else the camera moved

// y (px) of the printed 10 cm marks, measured at 640x480, and the metres they read.
const MARKS: [number, number][] = [
  [107.5, 3.8],
  [130.8, 3.7],
  [151, 3.6],
  [174.2, 3.5],
  [194.5, 3.4],
  [216.7, 3.3],
  [236.7, 3.2],
  [256.7, 3.1],
  [275.8, 3.0],
  [296.7, 2.9],
  [315, 2.8],
  [333.3, 2.7],
  [350.8, 2.6],
];

// Least-squares quadratic level(y): the camera looks down on the staff, so 10 cm spans ~22 px at
// the top and ~18 px near the water — not linear.
const FIT = (() => {
  const s = [0, 0, 0, 0, 0];
  const t = [0, 0, 0];
  for (const [y, v] of MARKS) {
    const u = y / 100;
    for (let k = 0; k < 5; k++) s[k] += u ** k;
    for (let k = 0; k < 3; k++) t[k] += v * u ** k;
  }
  // Solve the 3x3 normal equations by Cramer's rule.
  const m = [
    [s[0], s[1], s[2]],
    [s[1], s[2], s[3]],
    [s[2], s[3], s[4]],
  ];
  const det3 = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det3(m);
  const col = (k: number) => det3(m.map((row, i) => row.map((c, j) => (j === k ? t[i] : c))));
  return [col(0) / d, col(1) / d, col(2) / d] as const;
})();

export const levelAtY = (y: number) => {
  const u = y / 100;
  return FIT[0] + FIT[1] * u + FIT[2] * u * u;
};

type Rgb = { data: Uint8Array; width: number; height: number };

function isYellow(r: number, g: number, b: number) {
  return r > 140 && g > 100 && r - b > 80 && b < 0.62 * g;
}

/** Fraction of staff-strip pixels that are staff-yellow, per row. */
function yellowProfile(img: Rgb): Float32Array {
  const prof = new Float32Array(img.height);
  for (let y = 0; y < img.height; y++) {
    const cx = Math.round(staffCenterX(y));
    let n = 0;
    let total = 0;
    for (let x = cx - STRIP_HALF_WIDTH; x <= cx + STRIP_HALF_WIDTH; x++) {
      if (x < 0 || x >= img.width) continue;
      const i = (y * img.width + x) * 4;
      total++;
      if (isYellow(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
    }
    prof[y] = total ? n / total : 0;
  }
  return prof;
}

/** Subpixel y of the waterline on the staff, or null when the frame can't be trusted. */
export function findWaterlineY(img: Rgb): number | null {
  if (img.width !== FRAME_W || img.height !== FRAME_H) return null;
  const prof = yellowProfile(img);

  // The staff top must sit where it was calibrated, otherwise the camera has been moved.
  let top = -1;
  for (let y = 40; y < 140; y++) {
    let sum = 0;
    for (let k = 0; k < 8; k++) sum += prof[y + k];
    if (prof[y] >= 0.25 && sum >= 1.6) {
      top = y;
      break;
    }
  }
  if (top < STAFF_TOP_RANGE[0] || top > STAFF_TOP_RANGE[1]) return null;

  // Lowest row that is yellow AND continues upward as a solid staff. Murky water hides the
  // submerged part, so the last yellow row is the surface; the continuity test rejects lamp
  // reflections on the water, which are yellow but never form a 25 px column.
  for (let y = FRAME_H - 20; y > top + 40; y--) {
    if (prof[y] < 0.3) continue;
    let ok = 0;
    for (let k = 1; k <= 25; k++) if (prof[y - k] >= 0.2) ok++;
    if (ok >= 18) return y + 0.5;
  }
  return null;
}

// --- Frames: the segment is H.264 in MPEG-TS, so let ffmpeg decode it --------------------------

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null) || "ffmpeg";
}

// Every FRAME_STEP-th frame of the segment as JPEG, split out of ffmpeg's image2pipe stream.
function decodeFrames(segment: Uint8Array): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath(),
      [
        "-loglevel", "error", "-i", "pipe:0",
        "-vf", `select='not(mod(n,${FRAME_STEP}))'`, "-fps_mode", "vfr",
        "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => (err += c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.stdin.on("error", () => {}); // ffmpeg may close stdin early
    proc.on("close", (code) => {
      clearTimeout(timer);
      const all = Buffer.concat(out);
      const frames: Uint8Array[] = [];
      let start = -1;
      for (let i = 0; i + 1 < all.length; i++) {
        if (all[i] === 0xff && all[i + 1] === 0xd8 && start < 0) start = i;
        else if (all[i] === 0xff && all[i + 1] === 0xd9 && start >= 0) {
          frames.push(all.subarray(start, i + 2));
          start = -1;
        }
      }
      if (frames.length === 0) reject(new Error(`ffmpeg produced no frames (exit ${code}): ${err.slice(0, 200)}`));
      else resolve(frames);
    });
    proc.stdin.end(segment);
  });
}

async function getBytes(url: string, timeoutMs: number) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CCTV ${url} -> HTTP ${res.status}`);
  return res;
}

export const SUANTHEP_SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, "cctv-suanthep.jpg");

async function saveSnapshot(jpeg: Uint8Array) {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const tmp = `${SUANTHEP_SNAPSHOT_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, jpeg);
  await rename(tmp, SUANTHEP_SNAPSHOT_FILE);
}

export type CctvReading = {
  /** Metres on the staff (= ม.รทก.). */
  level: number;
  /** When the stream's newest segment was written. */
  updatedAt: string;
  framesUsed: number;
  /** Spread of the per-frame readings (m): small = calm water, large = waves/glare. */
  spread: number;
};

export async function readSuanThepGauge(): Promise<CctvReading> {
  const pl = await getBytes(`${STREAM_BASE}/playlist.m3u8`, 15_000);
  const modified = pl.headers.get("last-modified");
  const updatedMs = modified ? new Date(modified).getTime() : Date.now();
  if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > MAX_PLAYLIST_AGE_MS) {
    throw new Error("CCTV stream is not updating");
  }
  const segments = (await pl.text()).split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const last = segments[segments.length - 1];
  if (!last) throw new Error("CCTV playlist is empty");

  const seg = new Uint8Array(await (await getBytes(`${STREAM_BASE}/${last}`, 60_000)).arrayBuffer());
  const jpegs = await decodeFrames(seg);
  if (jpegs.length < FRAMES_SAMPLED) throw new Error(`CCTV segment has only ${jpegs.length} frames`);

  const lines: number[] = [];
  const used: { y: number; jpeg: Uint8Array }[] = [];
  for (let i = 0; i < FRAMES_SAMPLED; i++) {
    const jpeg = jpegs[jpegs.length - 1 - i];
    try {
      const img = decode(jpeg, { useTArray: true, formatAsRGBA: true });
      const y = findWaterlineY({ data: img.data, width: img.width, height: img.height });
      if (y != null) {
        lines.push(y);
        used.push({ y, jpeg });
      }
    } catch {
      // a corrupt frame is skipped
    }
  }
  if (lines.length < 3) throw new Error("CCTV staff gauge not readable (camera moved, glare or night mode)");

  lines.sort((a, b) => a - b);
  const median = lines[Math.floor(lines.length / 2)];
  // Keep the frame whose reading is the median one: that is the picture the number came from.
  const shown = used.reduce((a, b) => (Math.abs(b.y - median) < Math.abs(a.y - median) ? b : a));
  await saveSnapshot(shown.jpeg);
  return {
    level: Math.round(levelAtY(median) * 100) / 100,
    updatedAt: new Date(updatedMs).toISOString(),
    framesUsed: lines.length,
    spread: Math.round((levelAtY(lines[0]) - levelAtY(lines[lines.length - 1])) * 100) / 100,
  };
}
