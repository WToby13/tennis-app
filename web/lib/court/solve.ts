import { LANDMARK_BY_ID, type Vec3 } from "./model";

/**
 * Court calibration: from a handful of landmarks clicked on one frame, recover
 * the full camera — focal length, where the phone is, which way it points — in
 * court coordinates (metres). Pure maths, shared by the panel (live overlay) and
 * the API route (which re-solves rather than trusting a client's numbers).
 *
 * Camera model: pinhole, square pixels, principal point at the image centre, no
 * lens distortion. iPhone video has distortion correction applied on-device, and
 * the reprojected overlay is what tells you whether that held.
 *
 * Method: a homography from the ground-plane landmarks seeds the camera at each
 * focal length on a grid; the best few seeds are refined against every landmark
 * (net-post tops included, which is what pins focal length down) by
 * Levenberg–Marquardt on reprojection error.
 *
 * Quick mode: exactly three court points (say the near singles corners and a T).
 * Three points give six equations for seven unknowns, so the focal length is
 * taken from the lens instead: phone ultra-wides sit near f = 0.39 × width
 * (~104°). That rough court is saved as source "clicks"; the analysis worker
 * then snaps it onto the painted lines (ml/ojo_replay/clicks.py) and posts the
 * refined pins back.
 */

/** Ultra-wide focal length as a fraction of the image width (ml autocal.LENS centre). */
export const QUICK_FOCAL = 0.39;

export interface PlacedLandmark {
  id: string;
  /** Image pixels, in the video's native resolution. */
  x: number;
  y: number;
}

export interface CourtCamera {
  /** Focal length in pixels. */
  f: number;
  cx: number;
  cy: number;
  /** Court → camera rotation, 3×3 row-major. Camera axes: x right, y down, z forward. */
  rotation: number[];
  /** Court → camera translation (metres). */
  translation: Vec3;
  /** Where the camera is, in court coordinates (metres). */
  position: Vec3;
  /** Horizontal field of view in degrees, for a human to sanity-check. */
  hfovDeg: number;
}

export type CalibrationQuality = "unchecked" | "good" | "fair" | "poor";

export interface CourtCalibration {
  version: 1;
  model: "pinhole";
  imageWidth: number;
  imageHeight: number;
  /** The frame the landmarks were placed on, seconds into the video. */
  frameS: number;
  landmarks: PlacedLandmark[];
  camera: CourtCamera;
  /** Ground plane (x, y, 1) in metres → image pixels, 3×3 row-major. */
  homography: number[];
  residuals: { id: string; errorPx: number }[];
  rmsErrorPx: number;
  maxErrorPx: number;
  /**
   * Constraints beyond the minimum that makes any four points fit exactly. Zero
   * means nothing checks the clicks — a misplaced pin still "fits".
   */
  redundancy: number;
  quality: CalibrationQuality;
  /** The pin that looks misplaced, and where the other pins say it should be. */
  suspect: { id: string; errorPx: number; expected: [number, number] } | null;
  warnings: string[];
  solvedAt: string;
  /**
   * Who placed the pins: a person in the panel, or the analysis pipeline's
   * automatic court detection. An automatic result is "auto" when its lines sit
   * on the paint well enough to trust, "review" when someone should check it.
   * `moved`: the camera moved during the recording, so one calibration can't
   * cover all of it.
   */
  source?: "manual" | "auto" | "clicks";
  /** Solved from three points with the focal length assumed (see QUICK_FOCAL). */
  quick?: boolean;
  /** An automatic result snapped from the owner's three quick points. */
  fromClicks?: boolean;
  autoStatus?: "auto" | "review";
  moved?: boolean;
}

export interface SolveInput {
  imageWidth: number;
  imageHeight: number;
  frameS: number;
  landmarks: PlacedLandmark[];
}

export type SolveResult = { ok: true; calibration: CourtCalibration } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Small linear algebra (3×3 row-major, plus a symmetric eigen-solver for the DLT)

type M3 = number[];

function mul3(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

function inv3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi). Columns of `vectors` are eigenvectors. */
function symmetricEigen(input: number[][]): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

/** Solve a small dense system A x = b (Gaussian elimination, partial pivoting). */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-15) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < n; r++) {
      const factor = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return x;
}

// ---------------------------------------------------------------------------
// Homography (normalised DLT)

function normaliser(pts: [number, number][]): M3 {
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return [k, 0, -k * mx, 0, k, -k * my, 0, 0, 1];
}

function applyH(h: M3, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** Homography mapping `src` → `dst`, from four or more correspondences. */
export function homographyDLT(src: [number, number][], dst: [number, number][]): M3 {
  const Ts = normaliser(src);
  const Td = normaliser(dst);
  const ata = Array.from({ length: 9 }, () => new Array(9).fill(0));
  for (let i = 0; i < src.length; i++) {
    const [x, y] = applyH(Ts, src[i][0], src[i][1]);
    const [u, v] = applyH(Td, dst[i][0], dst[i][1]);
    const rows = [
      [-x, -y, -1, 0, 0, 0, u * x, u * y, u],
      [0, 0, 0, -x, -y, -1, v * x, v * y, v],
    ];
    for (const r of rows)
      for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) ata[a][b] += r[a] * r[b];
  }
  const { values, vectors } = symmetricEigen(ata);
  let min = 0;
  for (let i = 1; i < 9; i++) if (values[i] < values[min]) min = i;
  const hn = vectors.map((row) => row[min]);
  const h = mul3(mul3(inv3(Td), hn), Ts);
  return h.map((x) => x / h[8]);
}

// ---------------------------------------------------------------------------
// Rotations

function rodrigues(r: Vec3): M3 {
  const theta = norm(r);
  if (theta < 1e-12) return [1, -r[2], r[1], r[2], 1, -r[0], -r[1], r[0], 1];
  const [kx, ky, kz] = scale(r, 1 / theta);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

/** Rotation matrix → axis-angle, via a quaternion (stable near 180°). */
function toRodrigues(R: M3): Vec3 {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = R;
  const tr = m00 + m11 + m22;
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const vn = Math.hypot(x, y, z);
  if (vn < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(vn, w);
  return [(x / vn) * angle, (y / vn) * angle, (z / vn) * angle];
}

// ---------------------------------------------------------------------------
// Camera

interface Pose {
  f: number;
  R: M3;
  t: Vec3;
}

/** Court point → camera coordinates. */
function toCamera(pose: Pose, p: Vec3): Vec3 {
  const { R, t } = pose;
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
  ];
}

/** Project a court point to image pixels; null when it's behind the camera. */
export function projectPoint(camera: CourtCamera, p: Vec3): [number, number] | null {
  const c = toCamera({ f: camera.f, R: camera.rotation, t: camera.translation }, p);
  if (c[2] <= 1e-6) return null;
  return [camera.cx + (camera.f * c[0]) / c[2], camera.cy + (camera.f * c[1]) / c[2]];
}

/**
 * Project a court segment, clipped to what's in front of the camera, so a line
 * running behind the phone (a near sideline, say) still draws its visible part.
 */
export function projectSegment(
  camera: CourtCamera,
  a: Vec3,
  b: Vec3,
): [[number, number], [number, number]] | null {
  const pose = { f: camera.f, R: camera.rotation, t: camera.translation };
  let ca = toCamera(pose, a);
  let cb = toCamera(pose, b);
  const near = 0.05;
  if (ca[2] < near && cb[2] < near) return null;
  if (ca[2] < near || cb[2] < near) {
    const s = (near - ca[2]) / (cb[2] - ca[2]);
    const clipped = add(ca, scale(sub(cb, ca), s));
    if (ca[2] < near) ca = clipped;
    else cb = clipped;
  }
  const px = (c: Vec3): [number, number] => [
    camera.cx + (camera.f * c[0]) / c[2],
    camera.cy + (camera.f * c[1]) / c[2],
  ];
  return [px(ca), px(cb)];
}

/** Camera from a ground homography at an assumed focal length. */
function decompose(H: M3, f: number, cx: number, cy: number, ground: Vec3[]): Pose | null {
  const B = mul3([1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1], H);
  const b1: Vec3 = [B[0], B[3], B[6]];
  const b2: Vec3 = [B[1], B[4], B[7]];
  const b3: Vec3 = [B[2], B[5], B[8]];
  let lambda = 2 / (norm(b1) + norm(b2));
  if (!Number.isFinite(lambda)) return null;
  // The court has to be in front of the camera.
  const depth = ground.reduce((s, p) => s + b1[2] * p[0] + b2[2] * p[1] + b3[2], 0);
  if (depth < 0) lambda = -lambda;
  let r1 = scale(b1, lambda);
  let r2 = scale(b2, lambda);
  // Nearest pair of orthonormal axes to (r1, r2), splitting the error evenly.
  const c = scale(add(r1, r2), 1 / norm(add(r1, r2)));
  const d = scale(sub(r1, r2), 1 / norm(sub(r1, r2)));
  r1 = scale(add(c, d), Math.SQRT1_2);
  r2 = scale(sub(c, d), Math.SQRT1_2);
  const r3 = cross(r1, r2);
  return {
    f,
    R: [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]],
    t: scale(b3, lambda),
  };
}

interface Obs {
  id: string;
  world: Vec3;
  px: [number, number];
}

const BEHIND_PENALTY = 1e4;

function residuals(pose: Pose, cx: number, cy: number, obs: Obs[]): number[] {
  const r: number[] = [];
  for (const o of obs) {
    const c = toCamera(pose, o.world);
    if (c[2] <= 1e-6) {
      r.push(BEHIND_PENALTY, BEHIND_PENALTY);
      continue;
    }
    r.push(cx + (pose.f * c[0]) / c[2] - o.px[0], cy + (pose.f * c[1]) / c[2] - o.px[1]);
  }
  return r;
}

const sumSq = (r: number[]) => r.reduce((s, x) => s + x * x, 0);

/** Levenberg–Marquardt over (log f, rotation vector, translation). */
function refine(start: Pose, cx: number, cy: number, obs: Obs[], fixedFocal = false): Pose {
  const pack = (p: Pose) => [Math.log(p.f), ...toRodrigues(p.R), ...p.t];
  const unpack = (x: number[]): Pose => ({
    f: Math.exp(x[0]),
    R: rodrigues([x[1], x[2], x[3]]),
    t: [x[4], x[5], x[6]],
  });
  let x = pack(start);
  let r = residuals(unpack(x), cx, cy, obs);
  let cost = sumSq(r);
  let mu = 1e-3;
  for (let iter = 0; iter < 200; iter++) {
    const J: number[][] = r.map(() => new Array(7).fill(0));
    for (let k = fixedFocal ? 1 : 0; k < 7; k++) {
      const h = 1e-6 * (1 + Math.abs(x[k]));
      const xp = x.slice();
      const xm = x.slice();
      xp[k] += h;
      xm[k] -= h;
      const rp = residuals(unpack(xp), cx, cy, obs);
      const rm = residuals(unpack(xm), cx, cy, obs);
      for (let i = 0; i < r.length; i++) J[i][k] = (rp[i] - rm[i]) / (2 * h);
    }
    const JtJ = Array.from({ length: 7 }, (_, a) =>
      Array.from({ length: 7 }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)),
    );
    const Jtr = Array.from({ length: 7 }, (_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v + mu * (v || 1) : v)));
      const step = solveLinear(A, Jtr.map((v) => -v));
      if (!step) {
        mu *= 10;
        continue;
      }
      const xn = x.map((v, k) => v + step[k]);
      const rn = residuals(unpack(xn), cx, cy, obs);
      const cn = sumSq(rn);
      if (cn < cost) {
        const small = step.every((s, k) => Math.abs(s) < 1e-10 * (1 + Math.abs(x[k])));
        x = xn;
        r = rn;
        mu = Math.max(mu / 3, 1e-12);
        improved = cost - cn > 1e-12 * cost && !small;
        cost = cn;
        break;
      }
      mu *= 4;
    }
    if (!improved) break;
  }
  return unpack(x);
}

// ---------------------------------------------------------------------------
// Public entry point

/** Whether some four of the ground points are in general position (no three on a line). */
function hasGeneralFour(pts: Vec3[]): boolean {
  const collinear = (a: Vec3, b: Vec3, c: Vec3) =>
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-3;
  const n = pts.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++) {
        if (collinear(pts[a], pts[b], pts[c])) continue;
        for (let d = c + 1; d < n; d++) {
          if (
            !collinear(pts[a], pts[b], pts[d]) &&
            !collinear(pts[a], pts[c], pts[d]) &&
            !collinear(pts[b], pts[c], pts[d])
          )
            return true;
        }
      }
  return false;
}

type Fit = { ok: true; pose: Pose; errors: { id: string; errorPx: number }[]; rms: number } | { ok: false; error: string };

/** A camera at `pos` looking at the middle of the court, upright. */
function lookingAtCourt(pos: Vec3, f: number): Pose {
  const z = scale(sub([0, 0, 0], pos), 1 / norm(sub([0, 0, 0], pos)));
  const xr = cross(z, [0, 0, 1]);
  const x = scale(xr, 1 / norm(xr));
  const y = cross(z, x);
  const R = [...x, ...y, ...z];
  return { f, R, t: [-(x[0] * pos[0] + x[1] * pos[1] + x[2] * pos[2]), -(y[0] * pos[0] + y[1] * pos[1] + y[2] * pos[2]), -(z[0] * pos[0] + z[1] * pos[1] + z[2] * pos[2])] };
}

/**
 * Three ground points, focal length from the lens: the pose that puts them
 * exactly on the clicks. Several upright starting cameras around the near end,
 * refined; the best that sits above the court and behind the near baseline.
 */
function quickFit(obs: Obs[], W: number, H: number): Fit {
  const cx = W / 2;
  const cy = H / 2;
  const f = QUICK_FOCAL * W;
  let best: Pose | null = null;
  let bestCost = Infinity;
  for (const x of [-4, 0, 4])
    for (const y of [-13, -17, -24])
      for (const z of [1.5, 3, 5]) {
        const pose = refine(lookingAtCourt([x, y, z], f), cx, cy, obs, true);
        const c = cameraFor(pose, W, H).position;
        if (!(c[2] > 0.3 && c[1] < 0)) continue;
        const cost = sumSq(residuals(pose, cx, cy, obs));
        if (cost < bestCost) {
          best = pose;
          bestCost = cost;
        }
      }
  if (!best) return { ok: false, error: "Couldn't fit the court to these points. Check each is on the right landmark." };
  const res = residuals(best, cx, cy, obs);
  const errors = obs.map((o, i) => ({ id: o.id, errorPx: Math.hypot(res[2 * i], res[2 * i + 1]) }));
  const rms = Math.sqrt(errors.reduce((s, e) => s + e.errorPx ** 2, 0) / errors.length);
  return { ok: true, pose: best, errors, rms };
}

/** Best camera for a set of observations, or why there isn't one. */
function fit(obs: Obs[], W: number, H: number): Fit {
  const ground = obs.filter((o) => o.world[2] === 0);
  if (ground.length === 3 && obs.length === 3) {
    const [a, b, c] = ground.map((o) => o.world);
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-3) {
      return { ok: false, error: "These three points lie on one line. Use two corners and a T." };
    }
    return quickFit(obs, W, H);
  }
  if (ground.length < 3) {
    const n = 3 - ground.length;
    return { ok: false, error: `Place ${n} more point${n === 1 ? "" : "s"} on the court surface (three for a quick court, four or more for a checked one).` };
  }
  if (ground.length < 4) {
    return { ok: false, error: "Place one more point on the court surface." };
  }
  if (!hasGeneralFour(ground.map((o) => o.world))) {
    return {
      ok: false,
      error: "These points all lie along one or two lines. Add a point away from them, such as a corner on the other side.",
    };
  }

  const cx = W / 2;
  const cy = H / 2;
  const failed = { ok: false as const, error: "Couldn't fit the court to these points." };
  const Hg = homographyDLT(
    ground.map((o) => [o.world[0], o.world[1]]),
    ground.map((o) => o.px),
  );
  if (!Hg.every(Number.isFinite)) return failed;

  // Seed: scan focal length (very wide to telephoto), keep the best local minima.
  const steps = 240;
  const scan: { pose: Pose; cost: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const f = W * 0.15 * Math.pow(6 / 0.15, i / (steps - 1));
    const pose = decompose(Hg, f, cx, cy, ground.map((o) => o.world));
    if (pose) scan.push({ pose, cost: sumSq(residuals(pose, cx, cy, obs)) });
  }
  const minima = scan
    .filter(
      (s, i) =>
        (i === 0 || s.cost <= scan[i - 1].cost) && (i === scan.length - 1 || s.cost <= scan[i + 1].cost),
    )
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 3);

  let best: Pose | null = null;
  let bestCost = Infinity;
  for (const m of minima) {
    const pose = refine(m.pose, cx, cy, obs);
    const cost = sumSq(residuals(pose, cx, cy, obs));
    if (cost < bestCost) {
      best = pose;
      bestCost = cost;
    }
  }
  if (!best || !Number.isFinite(bestCost)) return failed;

  const res = residuals(best, cx, cy, obs);
  const errors = obs.map((o, i) => ({ id: o.id, errorPx: Math.hypot(res[2 * i], res[2 * i + 1]) }));
  const rms = Math.sqrt(errors.reduce((s, e) => s + e.errorPx ** 2, 0) / errors.length);
  return { ok: true, pose: best, errors, rms };
}

function cameraFor(pose: Pose, W: number, H: number): CourtCamera {
  const { f, R, t } = pose;
  return {
    f,
    cx: W / 2,
    cy: H / 2,
    rotation: R,
    translation: t,
    position: [
      -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
      -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
      -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ],
    hfovDeg: (2 * Math.atan(W / 2 / f) * 180) / Math.PI,
  };
}

export function solveCalibration(input: SolveInput): SolveResult {
  const { imageWidth: W, imageHeight: H } = input;
  const obs: Obs[] = [];
  for (const l of input.landmarks) {
    const def = LANDMARK_BY_ID.get(l.id);
    if (def) obs.push({ id: l.id, world: def.pos, px: [l.x, l.y] });
  }

  const result = fit(obs, W, H);
  if (!result.ok) return result;
  const { pose, errors, rms } = result;
  const camera = cameraFor(pose, W, H);
  const quick = obs.length === 3;
  const redundancy = quick ? 0 : 2 * obs.length - 8;

  // Thresholds are for 1080p; scale with resolution.
  const s = H / 1080;
  const good = 2.5 * s;
  const fair = 6 * s;
  const quality: CalibrationQuality =
    redundancy === 0 ? "unchecked" : rms <= good ? "good" : rms <= fair ? "fair" : "poor";

  // One bad pin smears its error over all the others, so the largest residual
  // doesn't name it. Refit without each pin in turn: the one whose removal
  // leaves a clean fit is the suspect, and that fit says where it belongs.
  let suspect: CourtCalibration["suspect"] = null;
  if (quality === "fair" || quality === "poor") {
    let bestRms = Infinity;
    for (const o of obs) {
      const rest = obs.filter((x) => x !== o);
      if (2 * rest.length - 8 < 1) continue; // nothing left to check the refit
      const loo = fit(rest, W, H);
      if (!loo.ok || loo.rms >= bestRms) continue;
      bestRms = loo.rms;
      const expected = projectPoint(cameraFor(loo.pose, W, H), o.world);
      suspect = expected
        ? { id: o.id, errorPx: Math.hypot(expected[0] - o.px[0], expected[1] - o.px[1]), expected }
        : null;
    }
    if (!(bestRms <= good && bestRms < rms / 2)) suspect = null;
  }

  const warnings: string[] = [];
  if (quick && rms > 2) {
    warnings.push("These three points don't fit an ultra-wide camera exactly. Check each is on its landmark.");
  }
  if (suspect) {
    const label = LANDMARK_BY_ID.get(suspect.id)?.label ?? suspect.id;
    warnings.push(
      `“${label}” is ${suspect.errorPx.toFixed(0)} px from where the other points put it. Is it on the right landmark?`,
    );
  }
  if (camera.position[2] < 0.3) {
    warnings.push(
      "The camera comes out at or below court level. Left and right may be swapped, or a point is on the wrong landmark.",
    );
  } else if (camera.position[2] > 20) {
    warnings.push(`The camera comes out ${camera.position[2].toFixed(0)} m up. A point is probably on the wrong landmark.`);
  }
  if (camera.hfovDeg < 15 || camera.hfovDeg > 150) {
    warnings.push(`The field of view comes out at ${camera.hfovDeg.toFixed(0)}°, which no phone lens has. Check the points.`);
  }

  const { f, R, t } = pose;
  const homography = mul3(
    [f, 0, camera.cx, 0, f, camera.cy, 0, 0, 1],
    [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]],
  );

  return {
    ok: true,
    calibration: {
      version: 1,
      model: "pinhole",
      imageWidth: W,
      imageHeight: H,
      frameS: input.frameS,
      landmarks: obs.map((o) => ({ id: o.id, x: o.px[0], y: o.px[1] })),
      camera,
      homography: homography.map((v) => v / homography[8]),
      residuals: errors,
      rmsErrorPx: rms,
      maxErrorPx: Math.max(...errors.map((e) => e.errorPx)),
      redundancy,
      quality,
      suspect,
      warnings,
      solvedAt: new Date().toISOString(),
      ...(quick ? { quick: true } : {}),
    },
  };
}
