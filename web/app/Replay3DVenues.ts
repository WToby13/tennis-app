import { SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import type { MatchScene } from "@/lib/matchScene";

/**
 * Where the 3D view's match is played: everything around the players, ball,
 * lines and net (Replay3D draws those the same in every venue).
 *
 * - "court": the court it was recorded on. Its surface from the video, and its
 *   surroundings (fences, trees, buildings, sky) projected from the video back
 *   through the calibrated phone onto walls at the fences.
 * - "stadium": a big clay show court, in the style of Court Philippe-Chatrier:
 *   wide clay run-off, dark green walls, steep stands full of people, a roof
 *   ring overhead. Built from boxes and canvas textures; no photos or marks of
 *   any real venue.
 *
 * Court coordinates (metres: x across, y away from the phone, z up) map to
 * three.js as (x, z, -y), as in Replay3D.
 */
export type Venue = "court" | "stadium";

export interface BuiltVenue {
  group: THREE.Group;
  /** Background and fog colour, or a texture for the background. */
  background: THREE.Color | THREE.Texture;
  fog: THREE.Fog;
  dispose: () => void;
}

const S = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
const D = 5.485, HL = 11.885;

function disposeAll(group: THREE.Group, extra: { dispose: () => void }[]) {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      if (mat instanceof THREE.ShaderMaterial) {
        for (const u of Object.values(mat.uniforms)) if (u.value instanceof THREE.Texture) u.value.dispose();
      }
      mat.dispose();
    }
  });
  extra.forEach((d) => d.dispose());
}

function flat(w: number, h: number, mat: THREE.Material, z = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = z;
  m.receiveShadow = true;
  return m;
}

/** A wall standing on the court's edge, its face toward the middle. */
function wall(side: "far" | "near" | "left" | "right", hw: number, hl: number, height: number, mat: THREE.Material) {
  const across = side === "far" || side === "near";
  const m = new THREE.Mesh(new THREE.PlaneGeometry(across ? 2 * hw : 2 * hl, height), mat);
  const at = { far: S(0, hl, height / 2), near: S(0, -hl, height / 2), left: S(-hw, 0, height / 2), right: S(hw, 0, height / 2) }[side];
  m.position.copy(at);
  m.rotation.y = { far: 0, near: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 }[side];
  return m;
}

// ---------------------------------------------------------------------------
// The recorded court.

/**
 * Paints a wall with what the phone saw in that direction: each point is
 * projected through the calibrated camera into the plate. Wall the phone never
 * saw (behind it, beside it) takes the same point mirrored across the net,
 * which it did see, as the far half of the court's surface does: the left
 * stays on the left (turned half round, the left wall behind the phone showed
 * the far right's neighbouring court). Above everything it saw, the sky.
 *
 * The side walls near the phone it saw at a grazing angle, a few pixels
 * smeared over metres. So where both the point and its mirrored twin were
 * seen, the sharper wins: the one the phone saw more squarely and closer
 * (pixels per square metre go as cos(angle) / distance²). What's still
 * stretched far more one way than the other (the ultra-wide's corners) is
 * blurred to match, so it reads as out-of-focus background, not streaks.
 */
function projectedMaterial(scene: MatchScene, plate: THREE.Texture, sky: THREE.Color) {
  const c = scene.camera;
  const R = c.rotation;
  const p = new THREE.Vector3(...c.position);
  // t = -R p: court -> camera translation.
  const t = new THREE.Vector3(
    -(R[0] * p.x + R[1] * p.y + R[2] * p.z),
    -(R[3] * p.x + R[4] * p.y + R[5] * p.z),
    -(R[6] * p.x + R[7] * p.y + R[8] * p.z),
  );
  return new THREE.ShaderMaterial({
    uniforms: {
      plate: { value: plate },
      R: { value: new THREE.Matrix3().set(R[0], R[1], R[2], R[3], R[4], R[5], R[6], R[7], R[8]) },
      T: { value: t },
      K: { value: new THREE.Vector3(c.f, c.cx, c.cy) },
      size: { value: new THREE.Vector2(c.width, c.height) },
      sky: { value: sky },
      eye: { value: p },
    },
    vertexShader: /* glsl */ `
      varying vec3 vCourt;
      varying vec3 vNormal;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vCourt = vec3(w.x, -w.z, w.y);
        vec3 n = mat3(modelMatrix) * normal;
        vNormal = vec3(n.x, -n.z, n.y);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D plate;
      uniform mat3 R;
      uniform vec3 T;
      uniform vec3 K;
      uniform vec2 size;
      uniform vec3 sky;
      uniform vec3 eye;
      varying vec3 vCourt;
      varying vec3 vNormal;
      float sharpness(vec3 p, vec3 n) {
        vec3 r = p - eye;
        float d2 = dot(r, r);
        return abs(dot(normalize(r), normalize(n))) / d2;
      }
      bool look(vec3 p, out vec2 uv) {
        vec3 c = R * p + T;
        if (c.z < 0.5) return false;
        vec2 px = K.x * c.xy / c.z + K.yz;
        uv = vec2(px.x / size.x, 1.0 - px.y / size.y);
        return uv.x > 0.002 && uv.x < 0.998 && uv.y > 0.002 && uv.y < 0.998;
      }
      // The plate at uv, blurred by how lopsided its stretch on screen is: plate
      // pixels per screen pixel along the two axes of the stretch (singular
      // values of the uv Jacobian), the mip level their ratio.
      // Sharpness of a wall seen face-on from ~42 m (the far wall's top, from
      // the phone): below it, little image is spread over a lot of wall.
      const float WELL_SEEN = 1.0 / 1800.0;
      vec3 sharpSample(vec2 uv, float seenHow) {
        vec2 px = uv * vec2(textureSize(plate, 0));
        vec2 dx = dFdx(px), dy = dFdy(px);
        float a = dot(dx, dx), b = dot(dx, dy), c = dot(dy, dy);
        float root = sqrt((a - c) * (a - c) + 4.0 * b * b);
        float big = 0.5 * (a + c + root), small = max(0.5 * (a + c - root), 1e-8);
        float lod = max(0.5 * log2(big), 0.5 * log2(big / small) - 0.5);
        lod += max(0.0, log2(WELL_SEEN / seenHow));
        return textureLod(plate, uv, clamp(lod, 0.0, 7.0)).rgb;
      }
      void main() {
        vec3 twin = vec3(vCourt.x, -vCourt.y, vCourt.z);
        vec3 twinN = vec3(vNormal.x, -vNormal.y, vNormal.z);
        vec2 uv, uvTwin;
        bool seen = look(vCourt, uv), seenTwin = look(twin, uvTwin);
        vec3 col = sky;
        float how = sharpness(vCourt, vNormal), howTwin = sharpness(twin, twinN);
        if (seen && (!seenTwin || how >= howTwin)) col = sharpSample(uv, how);
        else if (seenTwin) col = sharpSample(uvTwin, howTwin);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * The court's surroundings as a Gaussian splat (ml/ojo_replay/venue_splat.py),
 * if it has one: fetched from `url` and drawn in place of the projected walls,
 * which stand in until it has loaded, and for courts that have none.
 */
function loadSplat(url: string, group: THREE.Group, walls: THREE.Group | null, renderer: THREE.WebGLRenderer, alive: () => boolean) {
  fetch(url)
    .then(async (res) => {
      if (!res.ok || !alive()) return;
      const fileType = res.headers.get("x-splat-format") === "spz" ? SplatFileType.SPZ : SplatFileType.PLY;
      const fileBytes = new Uint8Array(await res.arrayBuffer());
      if (!alive()) return;
      group.add(new SparkRenderer({ renderer }));
      const splat = new SplatMesh({
        fileBytes,
        fileType,
        onLoad: () => {
          if (!walls) return;
          walls.visible = false;
          walls.userData.replaced = true;
        },
      });
      // Court coordinates are z up; three.js is y up: (x, y, z) -> (x, z, -y).
      splat.rotation.x = -Math.PI / 2;
      group.add(splat);
    })
    .catch(() => {});
}

export function buildRecordedCourt(scene: MatchScene, renderer: THREE.WebGLRenderer, splatUrl?: string): BuiltVenue {
  const group = new THREE.Group();
  const extra: { dispose: () => void }[] = [];
  let disposed = false;
  let walls: THREE.Group | null = null;
  const su = scene.surroundings;
  const sky = su ? new THREE.Color().setRGB(su.sky[0] / 255, su.sky[1] / 255, su.sky[2] / 255, THREE.SRGBColorSpace) : new THREE.Color(0x14110d);

  const surround = new THREE.MeshLambertMaterial({ color: 0x8a4a30 });
  group.add(flat(400, 400, surround, -0.02)); // to the horizon, where the fog takes it
  if (scene.court) {
    const { halfWidth, halfLength } = scene.court;
    const tex = new THREE.TextureLoader().load(scene.court.texture, (t) => {
      // The ground beyond the texture takes the texture's own edge colour.
      const img = t.image as HTMLImageElement;
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const g = cv.getContext("2d");
      if (g) {
        g.drawImage(img, 1, 1, 1, 1, 0, 0, 1, 1);
        const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
        surround.color.setRGB(r / 255, gr / 255, b / 255, THREE.SRGBColorSpace);
      }
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    group.add(flat(2 * halfWidth, 2 * halfLength, new THREE.MeshLambertMaterial({ map: tex }), -0.01));
  } else {
    group.add(flat(2 * (D + 3.5), 2 * (HL + 6.4), new THREE.MeshLambertMaterial({ color: 0xa35a3a }), -0.01));
  }

  if (su) {
    // Shown once the plate has decoded: before that they'd be black.
    const w = (walls = new THREE.Group());
    w.visible = false;
    // Unless a splat has already taken their place.
    const plate = new THREE.TextureLoader().load(su.plate, () => (w.visible = !w.userData.replaced));
    plate.colorSpace = THREE.SRGBColorSpace;
    const mat = projectedMaterial(scene, plate, sky);
    // Tall enough that, from inside, there's wall wherever the phone saw anything.
    const height = 30;
    for (const side of ["far", "near", "left", "right"] as const) w.add(wall(side, su.halfWidth, su.halfLength, height, mat));
    group.add(w);
  }
  if (splatUrl) loadSplat(splatUrl, group, walls, renderer, () => !disposed);

  // The phone, where the calibration put it.
  const c = scene.camera;
  const R = c.rotation;
  const phone = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.012), new THREE.MeshLambertMaterial({ color: 0xd9662c }));
  phone.add(body);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, c.position[2], 8), new THREE.MeshLambertMaterial({ color: 0x6b6258 }));
  pole.position.y = -c.position[2] / 2;
  phone.add(pole);
  phone.position.copy(S(...c.position));
  phone.lookAt(phone.position.clone().add(S(R[6], R[7], R[8])));
  group.add(phone);

  return {
    group,
    background: su ? sky : new THREE.Color(0x14110d),
    fog: su ? new THREE.Fog(sky.getHex(), 60, 160) : new THREE.Fog(0x14110d, 45, 110),
    dispose: () => {
      disposed = true;
      group.traverse((o) => {
        if (o instanceof SplatMesh || o instanceof SparkRenderer) o.dispose();
      });
      disposeAll(group, extra);
    },
  };
}

// ---------------------------------------------------------------------------
// The stadium.

/** A deterministic random stream, so the crowd sits the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Clay: an even orange-red with grain, brushed along the court, worn behind the baselines. */
function clayTexture(hw: number, hl: number): THREE.CanvasTexture {
  const px = 24; // per metre
  const cv = document.createElement("canvas");
  cv.width = Math.round(2 * hw * px);
  cv.height = Math.round(2 * hl * px);
  const g = cv.getContext("2d")!;
  g.fillStyle = "#c0592f";
  g.fillRect(0, 0, cv.width, cv.height);
  const r = rng(7);
  // Brush strokes along the court.
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${r() < 0.5 ? "150,62,30" : "214,112,66"},${0.05 + r() * 0.06})`;
    g.fillRect(r() * cv.width, r() * cv.height, 1 + r() * 3, 40 + r() * 160);
  }
  // Grain.
  for (let i = 0; i < 60000; i++) {
    g.fillStyle = r() < 0.5 ? "rgba(120,50,24,0.35)" : "rgba(230,140,96,0.3)";
    g.fillRect(r() * cv.width, r() * cv.height, 1, 1);
  }
  // Worn, lighter and smoother where the players stand behind each baseline.
  for (const end of [-1, 1]) {
    const cy = cv.height / 2 - end * (HL + 1.2) * px;
    const grad = g.createRadialGradient(cv.width / 2, cy, 0, cv.width / 2, cy, 4.5 * px);
    grad.addColorStop(0, "rgba(222,130,86,0.45)");
    grad.addColorStop(1, "rgba(222,130,86,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, cv.width, cv.height);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The dark green wall boards, our name on them in white. */
function boardTexture(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 96;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#0e4a33";
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = "#f4f1e8";
  g.font = "700 46px system-ui, -apple-system, sans-serif";
  g.textBaseline = "middle";
  g.textAlign = "center";
  g.fillText("OJO", cv.width * 0.25, cv.height / 2);
  g.fillText("OJO TENNIS", cv.width * 0.72, cv.height / 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

function skyTexture(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 2;
  cv.height = 256;
  const g = cv.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#4f8fd0");
  grad.addColorStop(0.6, "#9cc3e6");
  grad.addColorStop(1, "#e4edf3");
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildStadium(): BuiltVenue {
  const group = new THREE.Group();
  const extra: { dispose: () => void }[] = [];
  // Clay out to the walls: 9 m behind the baselines, 5.5 m beside the court.
  const hw = D + 5.5, hl = HL + 9;
  const wallH = 1.9;

  group.add(flat(500, 500, new THREE.MeshLambertMaterial({ color: 0x6f6a62 }), -0.03)); // concourse and beyond
  const clay = clayTexture(hw, hl);
  clay.anisotropy = 8;
  group.add(flat(2 * hw, 2 * hl, new THREE.MeshLambertMaterial({ map: clay }), -0.01));

  // The green walls round the clay.
  for (const side of ["far", "near", "left", "right"] as const) {
    const t = boardTexture();
    const len = side === "far" || side === "near" ? 2 * hw : 2 * hl;
    t.repeat.set(len / 9, 1);
    const w = wall(side, hw, hl, wallH, new THREE.MeshLambertMaterial({ map: t }));
    w.receiveShadow = true;
    group.add(w);
  }

  // Stands: two tiers of stepped rows on all four sides, seen from the court.
  // Each row is four boxes from the ground up (one per side), so the corners
  // close; the people are one instanced mesh.
  const steps: { x: number; y: number; w: number; d: number; h: number; z0: number }[] = [];
  const people: { x: number; y: number; z: number }[] = [];
  const tiers = [
    { a0: hw + 1.2, b0: hl + 1.2, z0: wallH + 0.4, rows: 24, depth: 0.85, rise: 0.42 },
    { a0: 0, b0: 0, z0: 0, rows: 16, depth: 0.85, rise: 0.62 },
  ];
  // The upper tier starts behind the lower one, over a concourse.
  {
    const lo = tiers[0];
    tiers[1].a0 = lo.a0 + lo.rows * lo.depth + 2.5;
    tiers[1].b0 = lo.b0 + lo.rows * lo.depth + 2.5;
    tiers[1].z0 = lo.z0 + lo.rows * lo.rise + 3.2;
  }
  const r = rng(11);
  for (const tier of tiers) {
    for (let k = 0; k < tier.rows; k++) {
      const a = tier.a0 + k * tier.depth, b = tier.b0 + k * tier.depth;
      const top = tier.z0 + (k + 1) * tier.rise;
      const d = tier.depth;
      steps.push({ x: -(a + d / 2), y: 0, w: d, d: 2 * (b + d), h: top, z0: 0 });
      steps.push({ x: a + d / 2, y: 0, w: d, d: 2 * (b + d), h: top, z0: 0 });
      steps.push({ x: 0, y: -(b + d / 2), w: 2 * (a + d), d: d, h: top, z0: 0 });
      steps.push({ x: 0, y: b + d / 2, w: 2 * (a + d), d: d, h: top, z0: 0 });
      // People along the row, a seat every 0.6 m, most of them taken.
      const off = 0.55 * d;
      const seat = (x: number, y: number) => r() < 0.88 && people.push({ x, y, z: top });
      for (let x = -(a + off); x <= a + off; x += 0.6) {
        seat(x, -(b + off));
        seat(x, b + off);
      }
      for (let y = -(b - 0.3); y <= b - 0.3; y += 0.6) {
        seat(-(a + off), y);
        seat(a + off, y);
      }
    }
  }
  const stepMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x5d665f }), steps.length);
  const m4 = new THREE.Matrix4();
  steps.forEach((s, i) => {
    m4.compose(S(s.x, s.y, s.z0 + s.h / 2), new THREE.Quaternion(), new THREE.Vector3(s.w, s.h, s.d));
    stepMesh.setMatrixAt(i, m4);
  });
  stepMesh.receiveShadow = true;
  group.add(stepMesh);

  // People, seated: a body in what they wear and a head, two instanced meshes.
  const bodyGeo = new THREE.BoxGeometry(0.44, 0.5, 0.3);
  bodyGeo.translate(0, 0.45 + 0.25, 0); // on the seat
  const headGeo = new THREE.BoxGeometry(0.2, 0.22, 0.2);
  headGeo.translate(0, 0.95 + 0.11, 0);
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), people.length);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), people.length);
  const wear = [0xf4f1ea, 0xf4f1ea, 0xe9e4d8, 0x1f2a44, 0x2f4f7f, 0xd8c7a6, 0x8a1c1c, 0x3a6b4a, 0xe8a43c, 0x222222, 0x9bb8d8, 0xd56b3a, 0xc9c2b8];
  const tops = [0xe2b896, 0xc89670, 0x8d5a3b, 0x5a3825, 0x2b2420, 0xd9c27a, 0x3b2a20, 0xf2f2ee];
  const col = new THREE.Color();
  people.forEach((p, i) => {
    const sc = 0.92 + r() * 0.16;
    m4.compose(S(p.x + (r() - 0.5) * 0.08, p.y + (r() - 0.5) * 0.08, p.z), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc));
    bodies.setMatrixAt(i, m4);
    heads.setMatrixAt(i, m4);
    bodies.setColorAt(i, col.setHex(wear[Math.floor(r() * wear.length)]));
    heads.setColorAt(i, col.setHex(tops[Math.floor(r() * tops.length)]));
  });
  group.add(bodies, heads);

  // Green fascia between the tiers, and along the top of the lower one.
  const fasciaMat = new THREE.MeshLambertMaterial({ color: 0x0e4a33 });
  const up = tiers[1];
  const lo = tiers[0];
  const fz = lo.z0 + lo.rows * lo.rise;
  for (const side of ["far", "near", "left", "right"] as const) {
    const f = wall(side, up.a0 - 0.6, up.b0 - 0.6, up.z0 - fz, fasciaMat);
    f.position.y += fz;
    group.add(f);
  }

  // The roof ring over the top tier (the roof itself open), white, with the
  // floodlights along its underside.
  const top = up.z0 + up.rows * up.rise;
  const ra = up.a0 + up.rows * up.depth + 1, rb = up.b0 + up.rows * up.depth + 1;
  const ringMat = new THREE.MeshLambertMaterial({ color: 0xf2f2ef });
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfffbe8 });
  const beam = (x: number, y: number, w: number, d: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.6, d), ringMat);
    m.position.copy(S(x, y, top + 6));
    group.add(m);
    const l = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.15, d * 0.9), lightMat);
    l.position.copy(S(x, y, top + 5.1));
    group.add(l);
  };
  beam(-ra, 0, 1.4, 2 * rb);
  beam(ra, 0, 1.4, 2 * rb);
  beam(0, -rb, 2 * ra, 1.4);
  beam(0, rb, 2 * ra, 1.4);
  for (const [x, y] of [[-ra, -rb], [ra, -rb], [-ra, rb], [ra, rb]]) {
    const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, top + 6, 1.2), ringMat);
    mast.position.copy(S(x, y, (top + 6) / 2));
    group.add(mast);
  }

  // The umpire's chair at the net, beside the court; the players' chairs by it.
  const green = new THREE.MeshLambertMaterial({ color: 0x0e4a33 });
  const chair = new THREE.Group();
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.0, 0.7), green);
  legs.position.y = 1.0;
  chair.add(legs);
  const seatBox = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), green);
  seatBox.position.y = 2.45;
  chair.add(seatBox);
  chair.position.copy(S(-(D + 1.6), 0, 0));
  chair.traverse((o) => (o.castShadow = true));
  group.add(chair);
  for (const y of [-1.6, 1.6]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 1.6), green);
    bench.position.copy(S(-(hw - 0.6), y, 0.45));
    bench.castShadow = true;
    group.add(bench);
  }

  const background = skyTexture();
  extra.push(background);
  return {
    group,
    background,
    fog: new THREE.Fog(0xdfe9f1, 120, 320),
    dispose: () => disposeAll(group, extra),
  };
}
