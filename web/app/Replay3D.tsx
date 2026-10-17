"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { End } from "@/lib/matchStats";
import type { MatchScene, SceneRally, SceneShot } from "@/lib/matchScene";
import { PlayerCutouts, makeReadable } from "./Replay3DPeople";
import { buildRecordedCourt, buildStadium, STADIUM_CREDIT, type BuiltVenue, type Venue } from "./Replay3DVenues";

/**
 * The match in 3D, over the video: the court (wearing the real court's
 * surface), both players, and the ball's flights and bounces, rebuilt by our
 * analysis (lib/matchScene.ts). The video stays the clock: whatever plays,
 * scrubs, frame-steps or slows the video moves the scene, so the player's own
 * controls drive it.
 *
 * Views ease the camera between presets; dragging takes over (free orbit).
 * "Phone" looks through the calibrated phone itself, drawn over the video it
 * was calibrated on, which is also how to check the rebuild lines up. Elsewhere
 * the video plays in a corner.
 */

// Court metres (x across, y away from the phone, z up) -> three.js (y up).
const S = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
const C = { HL: 11.885, SV: 6.4, D: 5.485, SG: 4.115, POST: 6.4, POSTH: 1.07, NETC: 0.914 };
const COLOUR = { A: 0xf0954e, B: 0x64a2ec, "": 0xd8d2c6, ball: 0xe8f24a, line: 0xf6efe4 } as const;
const CALL = { in: 0x7fd18b, close: 0xf2c14e, out: 0xef6f62, net: 0xd8d2c6 } as const;
// Human3.6M joints: hip, r_hip, r_knee, r_foot, l_hip, l_knee, l_foot, spine,
// thorax, neck, head, l_shoulder, l_elbow, l_wrist, r_shoulder, r_elbow, r_wrist.
const BONES = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6], [0, 7], [7, 8], [8, 9], [9, 10],
  [8, 11], [11, 12], [12, 13], [8, 14], [14, 15], [15, 16]] as const;
const HEAD = 10;
const TRAIL = 9; // frames of ball trail
const EASE = 0.08; // per frame, toward a preset's camera
const BRIDGE = 30; // frames: gaps in a player's detections drawn across (scene.py BRIDGE)

type View = "phone" | "broadcast" | "hitter" | "side" | "top" | "free";
const VIEWS: [View, string][] = [
  ["phone", "Phone"],
  ["broadcast", "Broadcast"],
  ["hitter", "Behind the hitter"],
  ["side", "Side on"],
  ["top", "Top down"],
];

const VENUES: [Venue, string, string][] = [
  ["court", "Your court", "Where it was played, its surroundings taken from the video"],
  ["stadium", "Stadium", "The same match on your court's own surface, in a covered show-court stadium"],
];

/** Index of the last element whose key <= x in a sorted array, or -1. */
function floorBy<T>(arr: T[], x: number, key: (v: T) => number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function bytesOf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** A skeleton's joints in court cm, 17 × xyz per frame (hips + offsets). */
function decodeJoints(root: string, joints: string): Float32Array {
  const r = new Int16Array(bytesOf(root)), o = new Int8Array(bytesOf(joints));
  const out = new Float32Array(o.length);
  for (let i = 0; i < o.length; i++) out[i] = r[Math.floor(i / 51) * 3 + (i % 3)] + o[i];
  return out;
}

/** Where a shot's ball is at time t (court metres), or null outside its flight. */
function ballAt(s: SceneShot, t: number, fps: number): [number, number, number] | null {
  const n = s.path.length / 3;
  const k = (t - s.t0) * fps;
  if (k < 0 || k > n - 1) return null;
  const i = Math.floor(k), w = k - i, j = Math.min(i + 1, n - 1);
  const p = s.path;
  return [0, 1, 2].map((c) => ((1 - w) * p[i * 3 + c] + w * p[j * 3 + c]) / 100) as [number, number, number];
}

export function Replay3D({
  scene,
  videoId,
  videoRef,
  onTogglePlay,
}: {
  scene: MatchScene;
  /** For the match's venue splat (/api/videos/:id/match-venue). */
  videoId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onTogglePlay: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pipRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>("broadcast");
  const viewRef = useRef<View>(view);
  const [venue, setVenueName] = useState<Venue>("court");
  /** The real players (cut out of the video) instead of figures, once the video is readable. */
  const [real, setReal] = useState(true);
  const realRef = useRef(real);
  realRef.current = real;
  const [canCutOut, setCanCutOut] = useState(false);
  const venueRef = useRef<Venue>(venue);
  venueRef.current = venue;
  const [hud, setHud] = useState<string>("");
  const togglePlay = useRef(onTogglePlay);
  togglePlay.current = onTogglePlay;

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fps = scene.fps;
    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(d: T) => (disposables.push(d), d);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = "r3d-canvas";
    host.prepend(renderer.domElement);

    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 300);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 2;
    controls.maxDistance = 80;

    world.add(new THREE.HemisphereLight(0xfff4e6, 0x2a1a10, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-10, 28, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 22, bottom: -22, near: 1, far: 70 });
    world.add(sun);
    // A softer light from the far end, so a player seen from there isn't a silhouette.
    const fill = new THREE.DirectionalLight(0xfff1e0, 0.7);
    fill.position.set(8, 14, -24);
    world.add(fill);

    // ---- The court: the venue round it, crisp lines, the net. ----
    // `ground` is everything that hides when looking through the phone (the
    // video is the ground there): the venue, and the lines and net every venue shares.
    const ground = new THREE.Group();
    world.add(ground);
    let venue: { name: Venue; built: BuiltVenue } | null = null;
    const setVenue = (name: Venue) => {
      if (venue?.name === name) return;
      if (venue) {
        ground.remove(venue.built.group);
        venue.built.dispose();
      }
      const built = name === "stadium" ? buildStadium(scene, renderer) : buildRecordedCourt(scene, renderer, `/api/videos/${videoId}/match-venue`);
      ground.add(built.group);
      venue = { name, built };
      lastView = null; // background and fog follow the venue
    };
    const lineMat = keep(new THREE.MeshBasicMaterial({ color: COLOUR.line, transparent: true, opacity: 0.85 }));
    const line = (x1: number, y1: number, x2: number, y2: number, w = 0.05) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(len + w, w)), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = Math.atan2(y2 - y1, x2 - x1);
      m.position.copy(S((x1 + x2) / 2, (y1 + y2) / 2, 0.003));
      ground.add(m);
    };
    ([
      [-C.D, C.HL, C.D, C.HL, 0.08], [-C.D, -C.HL, C.D, -C.HL, 0.08], [-C.D, -C.HL, -C.D, C.HL], [C.D, -C.HL, C.D, C.HL],
      [-C.SG, -C.HL, -C.SG, C.HL], [C.SG, -C.HL, C.SG, C.HL], [-C.SG, C.SV, C.SG, C.SV], [-C.SG, -C.SV, C.SG, -C.SV],
      [0, -C.SV, 0, C.SV], [0, C.HL, 0, C.HL - 0.1], [0, -C.HL, 0, -C.HL + 0.1],
    ] as [number, number, number, number, number?][]).forEach((l) => line(...l));
    {
      const shape = new THREE.Shape();
      shape.moveTo(-C.POST, 0);
      shape.lineTo(C.POST, 0);
      shape.lineTo(C.POST, C.POSTH);
      shape.quadraticCurveTo(0, 2 * C.NETC - C.POSTH, -C.POST, C.POSTH);
      shape.lineTo(-C.POST, 0);
      const net = new THREE.Mesh(
        keep(new THREE.ShapeGeometry(shape)),
        keep(new THREE.MeshBasicMaterial({ color: 0x15130f, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })),
      );
      ground.add(net);
      const tape = new THREE.Mesh(
        keep(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(S(-C.POST, 0, C.POSTH), S(0, 0, 2 * C.NETC - C.POSTH), S(C.POST, 0, C.POSTH)), 40, 0.025, 6)),
        keep(new THREE.MeshLambertMaterial({ color: 0xf4f1ea })),
      );
      ground.add(tape);
      for (const x of [-C.POST, C.POST]) {
        const post = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.04, 0.04, C.POSTH, 12)), keep(new THREE.MeshLambertMaterial({ color: 0xdedede })));
        post.position.copy(S(x, 0, C.POSTH / 2));
        post.castShadow = true;
        ground.add(post);
      }
    }

    const cam = scene.camera;
    const Rm = cam.rotation;

    // ---- Players: skeletons (bones and joints), or a plain figure at the feet. ----
    type Figure = {
      group: THREE.Group; bones: THREE.Mesh[]; joints: THREE.Mesh[]; plain: THREE.Mesh;
      /** A ring on the ground under them: who's where, readable from any height. */
      ring: THREE.Mesh; mat: THREE.MeshLambertMaterial; ringMat: THREE.MeshBasicMaterial;
    };
    const ringGeo = keep(new THREE.RingGeometry(0.42, 0.55, 40));
    const boneGeo = keep(new THREE.CylinderGeometry(0.045, 0.045, 1, 8));
    const jointGeo = keep(new THREE.SphereGeometry(0.055, 12, 10));
    const headGeo = keep(new THREE.SphereGeometry(0.12, 16, 12));
    const plainGeo = keep(new THREE.CapsuleGeometry(0.22, 1.25, 6, 12));
    const figure = (): Figure => {
      const mat = keep(new THREE.MeshLambertMaterial({ color: COLOUR[""] }));
      const group = new THREE.Group();
      const bones = BONES.map(() => {
        const m = new THREE.Mesh(boneGeo, mat);
        m.castShadow = true;
        group.add(m);
        return m;
      });
      const joints = Array.from({ length: 17 }, (_, i) => {
        const m = new THREE.Mesh(i === HEAD ? headGeo : jointGeo, mat);
        m.castShadow = true;
        group.add(m);
        return m;
      });
      const plain = new THREE.Mesh(plainGeo, mat);
      plain.castShadow = true;
      group.add(plain);
      const ringMat = keep(new THREE.MeshBasicMaterial({ color: COLOUR[""], transparent: true, opacity: 0.85, depthWrite: false }));
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);
      world.add(group);
      return { group, bones, joints, plain, ring, mat, ringMat };
    };
    const figures: Record<End, Figure> = { near: figure(), far: figure() };
    const up = new THREE.Vector3(0, 1, 0);
    const pts = Array.from({ length: 17 }, () => new THREE.Vector3());
    const dir = new THREE.Vector3();

    // ---- Ball: the ball, its shadow, a trail; the rally's arcs and bounces. ----
    const ball = new THREE.Mesh(keep(new THREE.SphereGeometry(0.07, 16, 12)), keep(new THREE.MeshBasicMaterial({ color: COLOUR.ball })));
    ball.castShadow = true;
    world.add(ball);
    const shadow = new THREE.Mesh(keep(new THREE.CircleGeometry(0.08, 20)), keep(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false })));
    shadow.rotation.x = -Math.PI / 2;
    world.add(shadow);
    const trailGeo = keep(new THREE.BufferGeometry());
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((TRAIL + 1) * 3), 3));
    const trail = new THREE.Line(trailGeo, keep(new THREE.LineBasicMaterial({ color: COLOUR.ball, transparent: true, opacity: 0.8 })));
    trail.frustumCulled = false;
    world.add(trail);

    let rallyIdx = -1;
    let R: SceneRally | null = null;
    let rallyObjects: { obj: THREE.Object3D; shot: SceneShot; kind: "arc" | "ring" }[] = [];
    const skeletons = new Map<string, Float32Array>();
    const clearRally = () => {
      for (const { obj } of rallyObjects) {
        world.remove(obj);
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material)?.dispose();
      }
      rallyObjects = [];
    };
    const loadRally = (k: number) => {
      clearRally();
      rallyIdx = k;
      R = k >= 0 ? scene.rallies[k] : null;
      if (!R) return;
      for (const side of ["near", "far"] as End[]) {
        figures[side].mat.color.setHex(COLOUR[R.who[side] || ""]);
        figures[side].ringMat.color.setHex(COLOUR[R.who[side] || ""]);
      }
      for (const s of R.shots) {
        const n = s.path.length / 3;
        const arc = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(Array.from({ length: n }, (_, i) => S(s.path[i * 3] / 100, s.path[i * 3 + 1] / 100, s.path[i * 3 + 2] / 100))),
          new THREE.LineBasicMaterial({ color: COLOUR[R.who[s.hitter] || ""], transparent: true, opacity: 0.15 }),
        );
        world.add(arc);
        rallyObjects.push({ obj: arc, shot: s, kind: "arc" });
        if (s.bounce) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.13, 0.22, 32),
            new THREE.MeshBasicMaterial({ color: CALL[s.landing ?? "net"] ?? CALL.net, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.copy(S(s.bounce[1], s.bounce[2], 0.012));
          world.add(ring);
          rallyObjects.push({ obj: ring, shot: s, kind: "ring" });
        }
      }
    };

    /** Poses one player's figure for this frame; returns where they stand (court x, y), or null. */
    const posePlayer = (side: End, frame: number): [number, number] | null => {
      const fig = figures[side];
      const p = R?.players[side];
      fig.group.visible = false;
      if (!R || !p) return null;
      const sk = p.skeleton;
      if (sk && sk.f.length) {
        const key = `${R.idx}:${side}`;
        let J = skeletons.get(key);
        if (!J) skeletons.set(key, (J = decodeJoints(sk.root, sk.joints)));
        const i = floorBy(sk.f, frame, (f) => f);
        const j = Math.min(i + 1, sk.f.length - 1);
        if (i >= 0 && frame - sk.f[i] <= 4 || (i < 0 && sk.f[0] - frame <= 2)) {
          const a = Math.max(i, 0);
          // Blend between lifted frames, not across a gap where the player was lost.
          const w = j > a && sk.f[j] - sk.f[a] <= 6 ? Math.min(Math.max((frame - sk.f[a]) / (sk.f[j] - sk.f[a]), 0), 1) : 0;
          for (let q = 0; q < 17; q++) {
            const o0 = (a * 17 + q) * 3, o1 = (j * 17 + q) * 3;
            const x = ((1 - w) * J[o0] + w * J[o1]) / 100;
            const y = ((1 - w) * J[o0 + 1] + w * J[o1 + 1]) / 100;
            const z = ((1 - w) * J[o0 + 2] + w * J[o1 + 2]) / 100;
            pts[q].set(x, z, -y);
            fig.joints[q].position.copy(pts[q]);
          }
          BONES.forEach(([qa, qb], k) => {
            const m = fig.bones[k];
            dir.subVectors(pts[qb], pts[qa]);
            const len = dir.length();
            m.position.copy(pts[qa]).addScaledVector(dir, 0.5);
            m.scale.set(1, Math.max(len, 1e-3), 1);
            m.quaternion.setFromUnitVectors(up, dir.normalize());
          });
          fig.bones.forEach((m) => (m.visible = true));
          fig.joints.forEach((m) => (m.visible = true));
          fig.ring.position.set(pts[0].x, 0.008, pts[0].z);
          fig.plain.visible = false;
          fig.group.visible = true;
          // Feet: between the two feet joints (scene x = court x, scene z = -court y).
          return [(pts[3].x + pts[6].x) / 2, -(pts[3].z + pts[6].z) / 2];
        }
      }
      // No skeleton here: a figure standing at the feet, carried across gaps in
      // the detections up to a second (as the skeletons are), else not drawn.
      const i = floorBy(p.f, frame, (f) => f);
      if (i < 0) return null;
      const j = Math.min(i + 1, p.f.length - 1);
      const bridged = j > i && p.f[j] - p.f[i] <= BRIDGE;
      if (!bridged && frame - p.f[i] > 4) return null;
      const w = bridged ? Math.min(Math.max((frame - p.f[i]) / (p.f[j] - p.f[i]), 0), 1) : 0;
      const x = ((1 - w) * p.feet[i * 2] + w * p.feet[j * 2]) / 100;
      const y = ((1 - w) * p.feet[i * 2 + 1] + w * p.feet[j * 2 + 1]) / 100;
      fig.plain.position.copy(S(x, y, 0.22 + 0.625));
      fig.ring.position.copy(S(x, y, 0.008));
      fig.bones.forEach((m) => (m.visible = false));
      fig.joints.forEach((m) => (m.visible = false));
      fig.plain.visible = true;
      fig.group.visible = true;
      return [x, y];
    };
    /** A cut-out showing for this player: the figure stands down, its ring stays. */
    const standDown = (side: End) => {
      const fig = figures[side];
      fig.bones.forEach((m) => (m.visible = false));
      fig.joints.forEach((m) => (m.visible = false));
      fig.plain.visible = false;
    };

    // ---- The real players, cut out of the video (Replay3DPeople). ----
    let cutouts: PlayerCutouts | null = null;
    let unmounted = false;
    const video0 = videoRef.current;
    if (video0 && PlayerCutouts.possible(scene)) {
      void makeReadable(video0).then((ok) => {
        if (!ok || unmounted) return;
        cutouts = new PlayerCutouts(scene, video0);
        world.add(cutouts.group);
        setCanCutOut(true);
      });
    }

    // ---- Camera: presets eased toward, free orbit, or through the phone. ----
    const goal = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    let hitterEnd: End = "near", hitterX = 0, hitterY = -C.HL;
    const presetFor = (v: View) => {
      const flip = hitterEnd === "far" ? -1 : 1;
      const at: Record<Exclude<View, "phone" | "free">, [[number, number, number], [number, number, number]]> = {
        broadcast: [[0, -26, 9.5], [0, 1, 0]],
        // 6.5 m behind where they struck it, eye height a little over theirs,
        // looking at the net: the hitter in the foreground, the shot ahead.
        hitter: [[hitterX * 0.7, hitterY - flip * 6.5, 2.6], [hitterX * 0.25, 0, 0.4]],
        // In the stadium, from up in the lower stand, over the crowd's heads.
        side: venueRef.current === "stadium" ? [[24, 0, 15], [0, 0, 0]] : [[21, 0, 4.5], [0, 0, 0.6]],
        top: [[0, -0.5, 36], [0, 0, 0]],
      };
      const [p, t] = at[v as keyof typeof at];
      goal.pos.copy(S(...p));
      goal.target.copy(S(...t));
    };
    // Looking through the phone: its rotation, and a projection that maps the
    // picture as the video element letterboxes it.
    const phoneQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        S(Rm[0], Rm[1], Rm[2]), // camera right
        S(-Rm[3], -Rm[4], -Rm[5]), // camera up (image y is down)
        S(-Rm[6], -Rm[7], -Rm[8]), // three cameras look down -z
      ),
    );
    const phoneProjection = (cw: number, ch: number) => {
      const s = Math.min(cw / cam.width, ch / cam.height);
      const ox = (cw - cam.width * s) / 2, oy = (ch - cam.height * s) / 2;
      const n = camera.near;
      const u = (X: number) => (X - ox) / s, v = (Y: number) => (Y - oy) / s;
      camera.projectionMatrix.makePerspective(
        ((u(0) - cam.cx) / cam.f) * n, ((u(cw) - cam.cx) / cam.f) * n,
        ((cam.cy - v(0)) / cam.f) * n, ((cam.cy - v(ch)) / cam.f) * n, n, camera.far,
      );
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    };
    let lastView: View | null = null;
    const applyView = (v: View, cw: number, ch: number) => {
      const isPhone = v === "phone";
      ground.visible = !isPhone;
      world.background = isPhone || !venue ? null : venue.built.background;
      world.fog = isPhone || !venue ? null : venue.built.fog;
      if (isPhone) {
        camera.position.copy(S(...cam.position));
        camera.quaternion.copy(phoneQuat);
        phoneProjection(cw, ch);
        controls.enabled = false;
      } else if (lastView === "phone") {
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        controls.enabled = true;
        // Orbit from where the phone looks.
        controls.target.copy(camera.position).add(new THREE.Vector3(0, 0, -12).applyQuaternion(phoneQuat));
      }
      lastView = v;
    };

    // A drag on the scene takes the camera (free orbit); a click plays/pauses.
    let down: { x: number; y: number } | null = null;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onMove = (e: PointerEvent) => {
      if (!down || !e.buttons) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 && viewRef.current !== "free") {
        if (viewRef.current === "phone") applyView("free", el.clientWidth, el.clientHeight);
        setView("free");
        viewRef.current = "free";
      }
    };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4) togglePlay.current();
      down = null;
    };
    const onWheel = () => {
      if (viewRef.current !== "phone" && viewRef.current !== "free") {
        setView("free");
        viewRef.current = "free";
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: true });

    // Start on the broadcast view, already there.
    presetFor("broadcast");
    camera.position.copy(goal.pos);
    controls.target.copy(goal.target);

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      if (viewRef.current === "phone") phoneProjection(w, h);
      else {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let lastHud = "";
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const video = videoRef.current;
      const t = video?.currentTime ?? 0;
      const frame = t * fps;

      // The rally at t (with a little slack either side), else nothing moving.
      const k = floorBy(scene.rallies, t + 0.5, (r) => r.start);
      const inRally = k >= 0 && t <= scene.rallies[k].end + 0.5 ? k : -1;
      if (inRally !== rallyIdx) loadRally(inRally);

      figures.near.group.visible = figures.far.group.visible = false;
      ball.visible = shadow.visible = trail.visible = false;
      let label = R && !R.between ? "" : "Between points";
      if (R) {
        const feet = { near: posePlayer("near", frame), far: posePlayer("far", frame) };
        if (cutouts) {
          cutouts.group.visible = realRef.current && viewRef.current !== "phone";
          if (cutouts.group.visible) {
            const shown = cutouts.update(R, frame, feet, camera, host.clientHeight * renderer.getPixelRatio());
            (["near", "far"] as End[]).forEach((side) => shown[side] && standDown(side));
          }
        }
        // The shot in the air: the latest one started.
        const si = floorBy(R.shots, t, (s) => s.t0);
        const shot = si >= 0 ? R.shots[si] : null;
        const p = shot ? ballAt(shot, t, fps) : null;
        for (const o of rallyObjects) {
          if (o.kind === "arc") ((o.obj as THREE.Line).material as THREE.LineBasicMaterial).opacity = o.shot === shot ? 0.45 : 0.12;
          else o.obj.visible = !!o.shot.bounce && o.shot.bounce[0] <= t;
        }
        if (shot) {
          hitterEnd = shot.hitter;
          hitterX = shot.path[0] / 100;
          hitterY = shot.path[1] / 100;
        }
        if (shot && p) {
          ball.visible = shadow.visible = trail.visible = true;
          ball.position.copy(S(...p));
          shadow.position.copy(S(p[0], p[1], 0.006));
          shadow.scale.setScalar(1 + p[2] * 0.15);
          (shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, 0.45 - p[2] * 0.08);
          const arr = trailGeo.attributes.position.array as Float32Array;
          let n = 0;
          for (let d = TRAIL; d >= 0; d--) {
            const q = ballAt(shot, t - d / fps, fps);
            if (!q) continue;
            arr[n * 3] = q[0];
            arr[n * 3 + 1] = q[2];
            arr[n * 3 + 2] = -q[1];
            n++;
          }
          trailGeo.setDrawRange(0, n);
          trailGeo.attributes.position.needsUpdate = true;
          const who = R.who[shot.hitter];
          const parts = [`${who ? `Player ${who}` : shot.hitter === "near" ? "Near player" : "Far player"} · ${shot.speed} km/h`];
          if (shot.net != null && shot.net > 0) parts.push(`${shot.net.toFixed(2)} m over the net`);
          parts.push(`ball ${p[2].toFixed(1)} m up`);
          label = parts.join(" · ");
        }
      }
      if (label !== lastHud) setHud((lastHud = label));

      setVenue(venueRef.current);
      const v = viewRef.current;
      if (v !== lastView) applyView(v, host.clientWidth, host.clientHeight);
      if (v !== "phone" && v !== "free") {
        presetFor(v);
        camera.position.lerp(goal.pos, EASE);
        controls.target.lerp(goal.target, EASE);
      }
      if (v !== "phone") controls.update();
      renderer.render(world, camera);

      // The video in a corner when the scene covers it.
      const pip = pipRef.current;
      if (pip && video && v !== "phone" && video.videoWidth) {
        const g = pip.getContext("2d");
        const w = pip.clientWidth * Math.min(window.devicePixelRatio, 2);
        if (pip.width !== Math.round(w)) {
          pip.width = Math.round(w);
          pip.height = Math.round((w * video.videoHeight) / video.videoWidth);
        }
        g?.drawImage(video, 0, 0, pip.width, pip.height);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      clearRally();
      unmounted = true;
      cutouts?.dispose();
      venue?.built.dispose();
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      el.remove();
    };
  }, [scene, videoId, videoRef]);

  return (
    <div className={`r3d ${view === "phone" ? "r3d-ar" : ""}`} ref={hostRef}>
      {/* Cameras and venues, with the readout under them however many rows they wrap to. */}
      <div className="r3d-top">
      <div className="r3d-views" role="toolbar" aria-label="3D camera">
        {VIEWS.map(([v, label]) => (
          <button
            key={v}
            className={`r3d-view ${view === v ? "on" : ""}`}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
        {view === "free" && <span className="r3d-view on" aria-live="polite">Free · drag to orbit</span>}
        {canCutOut && (
          <>
            <span className="r3d-sep" aria-hidden="true" />
            <button
              className={`r3d-view ${real ? "on" : ""}`}
              aria-pressed={real}
              title="The players themselves, cut out of the video, or figures from their tracked poses"
              onClick={() => setReal((v) => !v)}
            >
              Real players
            </button>
          </>
        )}
        <span className="r3d-sep" aria-hidden="true" />
        {VENUES.map(([v, label, title]) => (
          <button
            key={v}
            className={`r3d-view ${venue === v ? "on" : ""}`}
            aria-pressed={venue === v}
            title={title}
            onClick={() => {
              setVenueName(v);
              // Through the phone you see the real court whatever the venue.
              if (v === "stadium" && view === "phone") setView("broadcast");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="r3d-info">
        {hud && <div className="r3d-hud">{hud}</div>}
        {/* CC BY-NC asks for credit and the licence, wherever its output shows. */}
        {scene.body === "videopose3d" && (
          <div className="r3d-credit">
            Poses:{" "}
            <a href="https://github.com/facebookresearch/VideoPose3D" target="_blank" rel="noreferrer">
              VideoPose3D
            </a>{" "}
            (Meta,{" "}
            <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noreferrer">
              CC BY-NC 4.0
            </a>
            )
          </div>
        )}
        {/* CC BY 4.0 asks for credit wherever the model is shown. */}
        {venue === "stadium" && (
          <div className="r3d-credit">
            <a href={STADIUM_CREDIT.href} target="_blank" rel="noreferrer">
              {STADIUM_CREDIT.text}
            </a>
          </div>
        )}
      </div>
      </div>
      {view !== "phone" && (
        <canvas
          ref={pipRef}
          className="r3d-pip"
          title="The video. Click to look through the phone"
          onClick={() => setView("phone")}
        />
      )}
    </div>
  );
}
