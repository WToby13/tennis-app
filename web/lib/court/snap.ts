/**
 * Snap a hand-placed pin onto the painted line crossing it's sitting on.
 *
 * Classical image processing, no model: in a small window around the pin, pick
 * out line-paint pixels (bright and unsaturated, whatever the surface colour),
 * then pull out straight lines one at a time — the strongest Hough line seeds
 * a fit that is refined against the paint pixels near it, and those pixels are
 * removed before looking for the next. The crossing nearest the pin wins, so
 * where two parallel lines sit a few pixels apart (doubles and singles
 * sidelines at the far end) the pin keeps the one the user meant.
 *
 * Court dimensions run to the outside edge of the lines while this finds the
 * centre of the paint. The difference is a couple of centimetres, below what one
 * pixel covers anywhere on an Ojo frame.
 */

export interface PixelWindow {
  /** RGBA, row-major, as from CanvasRenderingContext2D.getImageData. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Line {
  /** A point on the line and its unit direction, in window pixels. */
  px: number;
  py: number;
  dx: number;
  dy: number;
  /** Where its paint starts and ends, along the direction from (px, py). */
  from: number;
  to: number;
}

const THETA_STEPS = 180;
const MAX_LINES = 4;

/**
 * Returns the refined point in window coordinates (continuous: pixel i spans
 * [i, i + 1)), or null if there's no clear crossing near the pin.
 */
export function snapToCrossing(win: PixelWindow, pinX: number, pinY: number): [number, number] | null {
  const { data, width, height } = win;
  const n = width * height;
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    score[i] = 0.299 * r + 0.587 * g + 0.114 * b - 0.6 * (Math.max(r, g, b) - Math.min(r, g, b));
  }
  // A third of the way from the surface to the brightest paint. Line paint
  // stands well clear of the court colour; the low cut keeps far lines, which
  // are a fraction of a pixel wide and so only partly cover the pixels they
  // cross. The contrast floor keeps noise out.
  const sorted = Array.from(score).sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const bright = sorted[Math.floor(n * 0.99)];
  if (bright - median < 40) return null;
  const threshold = median + 0.35 * (bright - median);

  // Local orientation from the structure tensor: which way the paint's edges
  // face around each pixel, and how clearly (coherence 0–1). It lets a pixel
  // vote only for lines running its way, so a diagonal that clips two lines at a
  // corner, or two parallel sidelines, can't outvote the lines themselves.
  const { normal, coherence } = orientation(score, width, height);

  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  const phi: number[] = [];
  const coh: number[] = [];
  for (let i = 0; i < n; i++) {
    if (score[i] <= threshold) continue;
    // Pixel i covers [i, i + 1), so its centre is at i + 0.5.
    xs.push((i % width) + 0.5);
    ys.push(Math.floor(i / width) + 0.5);
    ws.push(score[i] - threshold);
    phi.push(normal[i]);
    coh.push(coherence[i]);
  }
  /** Whether pixel k's own orientation fits line l. */
  const runsAlong = (l: Line, k: number) => {
    if (coh[k] < 0.25) return true; // a junction or blob: no orientation to disagree with
    const lineNormal = Math.atan2(l.dx, -l.dy);
    let d = Math.abs(phi[k] - lineNormal) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d <= (25 * Math.PI) / 180;
  };

  /**
   * Find the lines and their crossing. `strict` fits each line only to pixels
   * whose own orientation agrees with it, which stops a line swallowing the
   * other arm of a thick corner. But beside a bright line a faint one's pixels
   * take on the bright line's orientation (a worn service line meeting a fresh
   * sideline), and strict fitting strips the faint line of the pixels that
   * place it. So strict goes first and the relaxed fit is the fallback.
   */
  const crossing = (strict: boolean): [number, number] | null => {
    const minLength = Math.max(8, 0.3 * Math.min(width, height));
    const bandFor = (spread: number) => Math.min(6, Math.max(2.5, 2 * spread + 1.5));
    const distTo = (l: Line, k: number) => Math.abs((xs[k] - l.px) * l.dy - (ys[k] - l.py) * l.dx);
    const found: { line: Line; band: number }[] = [];
    let remaining = xs.map((_, k) => k);
    let firstVotes = 0;
    for (let attempt = 0; attempt < MAX_LINES * 2 && found.length < MAX_LINES; attempt++) {
      if (remaining.length < 6) break;
      const peak = houghPeak(xs, ys, ws, phi, coh, remaining, width, height);
      if (!peak) break;
      // Only a floor relative to the strongest line: a thin service line meeting a
      // thick sideline has a fraction of its votes and is still the line we want.
      // Shape (below) is what really decides.
      if (attempt === 0) firstVotes = peak.votes;
      else if (peak.votes < firstVotes * 0.04) break;

      // Seed from the peak, then refit to the paint within a band of the line,
      // letting the band follow the paint's actual width.
      let line: Line = { px: peak.px, py: peak.py, dx: peak.dx, dy: peak.dy, from: 0, to: 0 };
      let band = 3;
      let members: number[] = [];
      let spread = Infinity;
      for (let iter = 0; iter < 5; iter++) {
        const near = remaining.filter((k) => distTo(line, k) <= band && (!strict || runsAlong(line, k)));
        if (near.length < 6) break;
        const fit = fitLine(xs, ys, ws, near);
        members = near;
        line = fit.line;
        spread = fit.spread;
        band = bandFor(spread);
      }
      if (members.length === 0) break;
      const taken = new Set(members);
      remaining = remaining.filter((k) => !taken.has(k));
      // Real paint is long and thin. A cluster of junction pixels isn't.
      if (spread <= 3 && line.to - line.from >= minLength) found.push({ line, band });
    }

    // Refit all the lines together, each pixel going to the line it's nearest.
    // Taken one at a time, the first line claims the junction and an L-corner's
    // other arm tilts it; split by nearest line, the junction divides evenly.
    for (let iter = 0; iter < 4 && found.length > 1; iter++) {
      const groups: number[][] = found.map(() => []);
      for (let k = 0; k < xs.length; k++) {
        let best = -1;
        let bestD = Infinity;
        found.forEach((f, i) => {
          const d = distTo(f.line, k);
          if (d <= f.band && d < bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0) groups[best].push(k);
      }
      found.forEach((f, i) => {
        if (groups[i].length < 6) return;
        const fit = fitLine(xs, ys, ws, groups[i]);
        f.line = fit.line;
        f.band = bandFor(fit.spread);
      });
    }
    // The crossing nearest the pin, between lines at least 15° apart, that lies
    // on both lines' paint rather than where they'd meet if extended. Near the
    // crossing each line's pixels went to whichever line was nearer, so each has
    // a gap there as wide as the other's band, longer the shallower the angle.
    const radius = Math.min(width, height) / 2;
    const onPaint = (l: Line, x: number, y: number, gap: number) => {
      const along = (x - l.px) * l.dx + (y - l.py) * l.dy;
      return along >= l.from - gap && along <= l.to + gap;
    };
    let bestPoint: [number, number] | null = null;
    let bestDist = Infinity;
    for (let a = 0; a < found.length; a++) {
      for (let b = a + 1; b < found.length; b++) {
        const { line: l1, band: b1 } = found[a];
        const { line: l2, band: b2 } = found[b];
        const det = l1.dx * l2.dy - l1.dy * l2.dx;
        const sinAngle = Math.abs(det);
        if (sinAngle < Math.sin((15 * Math.PI) / 180)) continue;
        const u = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det;
        const x = l1.px + u * l1.dx;
        const y = l1.py + u * l1.dy;
        if (!onPaint(l1, x, y, 3 + b2 / sinAngle) || !onPaint(l2, x, y, 3 + b1 / sinAngle)) continue;
        const dist = Math.hypot(x - pinX, y - pinY);
        if (dist <= radius && dist < bestDist) {
          bestDist = dist;
          bestPoint = [x, y];
        }
      }
    }
    return bestPoint;
  };

  return crossing(true) ?? crossing(false);
}

/**
 * Strongest straight line through the given pixels: a weighted Hough transform
 * in which each pixel votes only near its own orientation.
 */
function houghPeak(
  xs: number[],
  ys: number[],
  ws: number[],
  phi: number[],
  coh: number[],
  idx: number[],
  width: number,
  height: number,
): { px: number; py: number; dx: number; dy: number; votes: number } | null {
  const ox = width / 2;
  const oy = height / 2;
  const maxRho = Math.ceil(Math.hypot(width, height) / 2) + 1;
  const rhoBins = 2 * maxRho + 1;
  const acc = new Float32Array(THETA_STEPS * rhoBins);
  const spreadSteps = Math.round((8 * THETA_STEPS) / 180);
  for (const k of idx) {
    const x = xs[k] - ox;
    const y = ys[k] - oy;
    const w = ws[k] * coh[k];
    const centre = Math.round((phi[k] / Math.PI) * THETA_STEPS);
    for (let dt = -spreadSteps; dt <= spreadSteps; dt++) {
      const t = (((centre + dt) % THETA_STEPS) + THETA_STEPS) % THETA_STEPS;
      const theta = (t * Math.PI) / THETA_STEPS;
      const rho = Math.round(x * Math.cos(theta) + y * Math.sin(theta)) + maxRho;
      acc[t * rhoBins + rho] += w;
    }
  }
  // Sum each cell with its rho neighbours: a thick line spreads its votes over
  // several rho bins, and unsmoothed it would lose to a diagonal that clips two
  // lines at a corner.
  let best = -1;
  let votes = 0;
  for (let t = 0; t < THETA_STEPS; t++) {
    for (let r = 2; r < rhoBins - 2; r++) {
      const i = t * rhoBins + r;
      const v = acc[i - 2] + acc[i - 1] + acc[i] + acc[i + 1] + acc[i + 2];
      if (v > votes) {
        votes = v;
        best = i;
      }
    }
  }
  if (best < 0) return null;
  const theta = (Math.floor(best / rhoBins) * Math.PI) / THETA_STEPS;
  const rho = (best % rhoBins) - maxRho;
  return {
    px: ox + rho * Math.cos(theta),
    py: oy + rho * Math.sin(theta),
    dx: -Math.sin(theta),
    dy: Math.cos(theta),
    votes,
  };
}

/** Weighted total-least-squares line, with how far the paint spreads across it. */
function fitLine(
  xs: number[],
  ys: number[],
  ws: number[],
  idx: number[],
): { line: Line; spread: number } {
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (const k of idx) {
    sw += ws[k];
    mx += ws[k] * xs[k];
    my += ws[k] * ys[k];
  }
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const k of idx) {
    const dx = xs[k] - mx;
    const dy = ys[k] - my;
    sxx += ws[k] * dx * dx;
    syy += ws[k] * dy * dy;
    sxy += ws[k] * dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let across2 = 0;
  let from = Infinity;
  let to = -Infinity;
  for (const k of idx) {
    const along = (xs[k] - mx) * dx + (ys[k] - my) * dy;
    const across = (xs[k] - mx) * dy - (ys[k] - my) * dx;
    across2 += ws[k] * across * across;
    from = Math.min(from, along);
    to = Math.max(to, along);
  }
  return { line: { px: mx, py: my, dx, dy, from, to }, spread: Math.sqrt(across2 / sw) };
}

/**
 * Per-pixel edge normal (radians, 0–π) and coherence from the structure tensor
 * of `img`, averaged over a 7×7 neighbourhood — wide enough that the middle of
 * a thick line still sees both of its edges.
 */
function orientation(img: Float32Array, width: number, height: number) {
  const n = width * height;
  const jxx = new Float32Array(n);
  const jyy = new Float32Array(n);
  const jxy = new Float32Array(n);
  const at = (x: number, y: number) =>
    img[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      const i = y * width + x;
      jxx[i] = gx * gx;
      jyy[i] = gy * gy;
      jxy[i] = gx * gy;
    }
  }
  const normal = new Float32Array(n);
  const coherence = new Float32Array(n);
  const R = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let v = Math.max(0, y - R); v <= Math.min(height - 1, y + R); v++) {
        for (let u = Math.max(0, x - R); u <= Math.min(width - 1, x + R); u++) {
          const j = v * width + u;
          a += jxx[j];
          b += jyy[j];
          c += jxy[j];
        }
      }
      const i = y * width + x;
      let angle = 0.5 * Math.atan2(2 * c, a - b);
      if (angle < 0) angle += Math.PI;
      normal[i] = angle;
      coherence[i] = Math.sqrt((a - b) * (a - b) + 4 * c * c) / (a + b + 1e-9);
    }
  }
  return { normal, coherence };
}
