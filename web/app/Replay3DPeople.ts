import * as THREE from "three";
import type { End } from "@/lib/matchStats";
import type { MatchScene, SceneRally } from "@/lib/matchScene";

/**
 * The real players in the 3D view: each one cut out of the playing video,
 * frame by frame, and stood on the court where they were tracked, turned to
 * face whoever is looking.
 *
 * The cut is made on the GPU, live, from the video already playing: inside the
 * player's box in the picture, whatever differs from the empty court (the
 * recording's clean plate, scene.surroundings) is the player. No extra
 * processing or download. Seen from near the phone they are the people
 * themselves; from far off they're a photograph standing up, which still beats
 * a mannequin for knowing who's who and what they did.
 *
 * Reading the video's pixels needs it served with CORS (CloudFront sends the
 * headers for the app's own origins, infra/main.tf); when it isn't readable
 * the view keeps its figures.
 */

// Court metres (x across, y away from the phone, z up) -> three.js (y up).
const S = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
/** Gaps in the detections bridged, in frames (as for the figures). */
const BRIDGE = 30;
/** Box padding: detections are every few frames and people move between them. */
const PAD = 0.18;
/**
 * The most a cut-out may be enlarged on screen (screen pixels per video
 * pixel). The far player is ~40 px tall in the video: blown up to fill a
 * close view they're a smear, so there the figure stands in instead.
 */
const MAX_ZOOM = 3;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D video;
  uniform sampler2D plate;
  uniform vec4 rect;   // u0, v0, u1, v1 in the picture (v down, 0..1)
  uniform vec2 texel;  // one video pixel, in uv
  varying vec2 vUv;
  // How far the frame is from the empty court here, over a few pixels so
  // compression noise doesn't speckle the edge.
  float differs(vec2 t) {
    float d = 0.0;
    for (int i = 0; i < 5; i++) {
      vec2 o = i == 0 ? vec2(0.0) : vec2(i == 1 ? 1.5 : i == 2 ? -1.5 : 0.0, i == 3 ? 1.5 : i == 4 ? -1.5 : 0.0) * texel;
      vec3 c = texture2D(video, t + o).rgb, p = texture2D(plate, t + o).rgb;
      // Colour difference, plus brightness differences that aren't just the
      // light changing over the match (a ratio, not a difference).
      float lc = dot(c, vec3(0.299, 0.587, 0.114)), lp = dot(p, vec3(0.299, 0.587, 0.114));
      vec3 chroma = c / max(lc, 0.02) - p / max(lp, 0.02);
      d += length(chroma) * 0.35 + abs(log((lc + 0.02) / (lp + 0.02))) * 0.6;
    }
    return d / 5.0;
  }
  void main() {
    vec2 pic = vec2(mix(rect.x, rect.z, vUv.x), mix(rect.w, rect.y, vUv.y));
    vec2 t = vec2(pic.x, 1.0 - pic.y);
    float a = smoothstep(0.18, 0.34, differs(t));
    vec2 e = min(vUv, 1.0 - vUv);
    a *= smoothstep(0.0, 0.08, min(e.x, e.y));
    if (a < 0.05) discard;
    gl_FragColor = vec4(texture2D(video, t).rgb, a);
    #include <colorspace_fragment>
  }`;

/**
 * Makes the video's pixels readable by WebGL: same-origin already is; a
 * CloudFront URL is reloaded with `crossorigin`, keeping its time and
 * play state. Resolves false (and puts the video back) if the host refuses.
 */
export function makeReadable(video: HTMLVideoElement): Promise<boolean> {
  const src = video.currentSrc || video.src;
  if (!src) return Promise.resolve(false);
  if (new URL(src, location.href).origin === location.origin || video.crossOrigin === "anonymous") {
    return Promise.resolve(true);
  }
  const t = video.currentTime, playing = !video.paused;
  const reload = (cors: boolean) =>
    new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        video.removeEventListener("loadeddata", onData);
        video.removeEventListener("error", onError);
        resolve(ok);
      };
      const onData = () => {
        video.currentTime = t;
        if (playing) void video.play().catch(() => {});
        done(true);
      };
      const onError = () => done(false);
      video.addEventListener("loadeddata", onData);
      video.addEventListener("error", onError);
      if (cors) video.crossOrigin = "anonymous";
      else video.removeAttribute("crossorigin");
      video.load();
    });
  return reload(true).then((ok) => (ok ? true : reload(false).then(() => false)));
}

/** Index of the last value <= x in a sorted array, or -1. */
function lastAtOrBefore(arr: number[], x: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

interface Cutout {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

export class PlayerCutouts {
  readonly group = new THREE.Group();
  private readonly cutouts: Record<End, Cutout>;
  private readonly R: number[];
  private readonly t: THREE.Vector3;
  private readonly cam: MatchScene["camera"];
  private readonly textures: THREE.Texture[];
  /** The video's current frame, copied through a canvas (see refresh). */
  private readonly videoTex: THREE.CanvasTexture;
  private readonly frame2d: CanvasRenderingContext2D;
  private readonly video: HTMLVideoElement;
  private shownTime = -1;

  constructor(scene: MatchScene, video: HTMLVideoElement) {
    this.cam = scene.camera;
    this.R = scene.camera.rotation;
    const [px, py, pz] = scene.camera.position;
    const R = this.R;
    this.t = new THREE.Vector3(
      -(R[0] * px + R[1] * py + R[2] * pz),
      -(R[3] * px + R[4] * py + R[5] * pz),
      -(R[6] * px + R[7] * py + R[8] * pz),
    );
    // The frame goes through a 2D canvas rather than straight from the <video>
    // (THREE.VideoTexture, or a texture of the element): uploaded directly, a
    // paused or stepped video came out black, while drawing it to a canvas (as
    // the picture-in-picture does) gives the frame.
    const canvas = document.createElement("canvas");
    canvas.width = this.cam.width;
    canvas.height = this.cam.height;
    this.frame2d = canvas.getContext("2d")!;
    const videoTex = new THREE.CanvasTexture(canvas);
    videoTex.minFilter = THREE.LinearFilter;
    videoTex.generateMipmaps = false;
    videoTex.colorSpace = THREE.SRGBColorSpace;
    this.videoTex = videoTex;
    this.video = video;
    const plate = new THREE.TextureLoader().load(scene.surroundings!.plate);
    plate.colorSpace = THREE.SRGBColorSpace;
    this.textures = [videoTex, plate];
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0); // stands on its bottom edge
    const make = (): Cutout => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          video: { value: videoTex },
          plate: { value: plate },
          rect: { value: new THREE.Vector4() },
          texel: { value: new THREE.Vector2(1 / this.cam.width, 1 / this.cam.height) },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      return { mesh, mat };
    };
    this.cutouts = { near: make(), far: make() };
  }

  /** Can this scene show real players? It needs the empty-court plate. */
  static possible(scene: MatchScene): boolean {
    return !!scene.surroundings?.plate;
  }

  /** Court point -> [pixel u, v, depth along the phone's axis]. */
  private project(x: number, y: number, z: number): [number, number, number] {
    const R = this.R;
    const cx = R[0] * x + R[1] * y + R[2] * z + this.t.x;
    const cy = R[3] * x + R[4] * y + R[5] * z + this.t.y;
    const cz = R[6] * x + R[7] * y + R[8] * z + this.t.z;
    return [this.cam.f * (cx / cz) + this.cam.cx, this.cam.f * (cy / cz) + this.cam.cy, cz];
  }

  /** Copy the video's current frame when it has changed (playing, seeked, stepped). */
  private refresh() {
    const v = this.video;
    if (v.readyState < 2) return;
    if (!v.paused || v.currentTime !== this.shownTime) {
      this.frame2d.drawImage(v, 0, 0, this.cam.width, this.cam.height);
      this.videoTex.needsUpdate = true;
      this.shownTime = v.currentTime;
    }
  }

  /**
   * Stand each player's cut-out at their feet (court metres, from the same
   * posing as the figures) for this frame, facing `viewer` (drawn
   * `screenHeight` pixels tall). Returns which ends have one showing, so the
   * figures can stand down there.
   */
  update(
    rally: SceneRally | null,
    frame: number,
    feet: Record<End, [number, number] | null>,
    viewer: THREE.PerspectiveCamera,
    screenHeight: number,
  ): Record<End, boolean> {
    this.refresh();
    const shown = { near: false, far: false };
    for (const side of ["near", "far"] as End[]) {
      const c = this.cutouts[side];
      c.mesh.visible = false;
      const p = rally?.players[side];
      const at = feet[side];
      if (!p?.box || !at) continue;
      // The box at this frame, between detections (bridging short gaps).
      const i = lastAtOrBefore(p.f, frame);
      if (i < 0) continue;
      const j = Math.min(i + 1, p.f.length - 1);
      const bridged = j > i && p.f[j] - p.f[i] <= BRIDGE;
      if (!bridged && frame - p.f[i] > 4) continue;
      const w = bridged ? Math.min(Math.max((frame - p.f[i]) / (p.f[j] - p.f[i]), 0), 1) : 0;
      const box = [0, 1, 2, 3].map((k) => (1 - w) * p.box![i * 4 + k] + w * p.box![j * 4 + k]);
      const [fu, fv, depth] = this.project(at[0], at[1], 0);
      if (!(depth > 0.5)) continue;
      // A picture rectangle centred on the feet, padded, from the head down to
      // just under the shoes.
      const bw = box[2] - box[0], bh = box[3] - box[1];
      const half = Math.max(fu - box[0], box[2] - fu) + PAD * bw;
      const top = box[1] - PAD * bh;
      const bottom = fv + 0.06 * bh;
      const W = this.cam.width, H = this.cam.height;
      c.mat.uniforms.rect.value.set((fu - half) / W, top / H, (fu + half) / W, bottom / H);
      // Pixels -> metres at the player's distance.
      const mPerPx = depth / this.cam.f;
      c.mesh.scale.set(2 * half * mPerPx, (bottom - top) * mPerPx, 1);
      c.mesh.position.copy(S(at[0], at[1], -(bottom - fv) * mPerPx));
      // Too enlarged on screen to look like anything but a smear: the figure instead.
      const dist = viewer.position.distanceTo(c.mesh.position) || 1;
      const onScreen = (c.mesh.scale.y / (2 * dist * Math.tan((viewer.fov * Math.PI) / 360))) * screenHeight;
      if (onScreen > MAX_ZOOM * (bottom - top)) continue;
      // Turned to the viewer, upright.
      c.mesh.rotation.set(0, Math.atan2(viewer.position.x - c.mesh.position.x, viewer.position.z - c.mesh.position.z), 0);
      c.mesh.visible = true;
      shown[side] = true;
    }
    return shown;
  }

  dispose() {
    for (const c of Object.values(this.cutouts)) c.mat.dispose();
    this.cutouts.near.mesh.geometry.dispose();
    this.textures.forEach((t) => t.dispose());
  }
}
