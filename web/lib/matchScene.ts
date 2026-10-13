/**
 * A match as a 3D scene, as stored in match_analyses.scene and drawn by the
 * watch page's 3D view. Built by ml/ojo_replay/scene.py.
 *
 * Court coordinates: metres from centre court on the ground, +x to the
 * camera's right, +y away from the camera, +z up. Positions are integer
 * centimetres, flattened. Times are seconds from the start of the video, so the
 * video's clock drives the scene.
 */
import type { End, Who } from "./matchStats";

export interface SceneShot {
  hitter: End;
  t0: number;
  t1: number;
  /** km/h off the racket. */
  speed: number;
  landing: "in" | "out" | "close" | "net" | null;
  /** [t, x, y] in seconds and metres. */
  bounce: [number, number, number] | null;
  /** Height over the net, metres. */
  net: number | null;
  doubt: string | null;
  /** x, y, z (cm) per video frame from t0. */
  path: number[];
}

export interface ScenePlayer {
  /** Frames the player was detected in, and their feet there (x, y cm each). */
  f: number[];
  feet: number[];
  /**
   * 3D joints where they could be lifted, per frame in `f`: the hips as base64
   * little-endian int16 cm (xyz), and all 17 joints as base64 int8 cm offsets
   * from the hips (xyz; Human3.6M order, see BONES in Replay3D).
   */
  skeleton?: { f: number[]; root: string; joints: string };
}

export interface SceneRally {
  idx: number;
  start: number;
  end: number;
  /** Which player (A/B, by kit) was at each end, "" if unknown. */
  who: Record<End, Who | "">;
  shots: SceneShot[];
  players: Partial<Record<End, ScenePlayer>>;
}

export interface MatchScene {
  version: number;
  fps: number;
  /** The calibrated phone: position (m), court→camera rotation (row-major 3×3), pinhole. */
  camera: {
    position: [number, number, number];
    rotation: number[];
    f: number;
    cx: number;
    cy: number;
    width: number;
    height: number;
  };
  /** The real court's surface, top-down, centred on the court: row 0 is the far end. */
  court: { texture: string; halfWidth: number; halfLength: number } | null;
  /** What the skeletons were lifted with, or null when there are none. */
  body: string | null;
  rallies: SceneRally[];
}

export function isMatchScene(v: unknown): v is MatchScene {
  const s = v as MatchScene | null;
  return (
    !!s &&
    typeof s.version === "number" &&
    typeof s.fps === "number" &&
    !!s.camera &&
    Array.isArray(s.camera.position) &&
    Array.isArray(s.rallies)
  );
}
