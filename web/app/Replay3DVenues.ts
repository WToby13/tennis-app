import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { MatchScene } from "@/lib/matchScene";

/**
 * Where the 3D view's match is played: everything around the players, ball,
 * lines and net (Replay3D draws those the same in every venue).
 *
 * - "court": the court it was recorded on. Its surface from the video, and its
 *   surroundings (fences, trees, buildings, sky) projected from the video back
 *   through the calibrated phone onto walls at the fences.
 * - "stadium": a covered show court (Estadio Parque Roca, Buenos Aires, from a
 *   CC-BY model: credit in STADIUM_CREDIT), its clay swapped for the recorded
 *   court's own surface and its walls carrying our boards.
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
 * The recorded court's surface from the video, on a run-off of `runW` × `runL`
 * metres that takes the texture's own edge colour (the texture covers the
 * court and a little round it).
 */
function videoSurface(scene: MatchScene, renderer: THREE.WebGLRenderer, group: THREE.Group, runW: number, runL: number) {
  const surround = new THREE.MeshLambertMaterial({ color: 0x8a4a30 });
  group.add(flat(runW, runL, surround, -0.02));
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
}

export function buildRecordedCourt(scene: MatchScene, renderer: THREE.WebGLRenderer): BuiltVenue {
  const group = new THREE.Group();
  const extra: { dispose: () => void }[] = [];
  const su = scene.surroundings;
  const sky = su ? new THREE.Color().setRGB(su.sky[0] / 255, su.sky[1] / 255, su.sky[2] / 255, THREE.SRGBColorSpace) : new THREE.Color(0x14110d);

  videoSurface(scene, renderer, group, 400, 400); // to the horizon, where the fog takes it

  if (su) {
    // Shown once the plate has decoded: before that they'd be black.
    const walls = new THREE.Group();
    walls.visible = false;
    const plate = new THREE.TextureLoader().load(su.plate, () => (walls.visible = true));
    plate.colorSpace = THREE.SRGBColorSpace;
    const mat = projectedMaterial(scene, plate, sky);
    // Tall enough that, from inside, there's wall wherever the phone saw anything.
    const height = 30;
    for (const side of ["far", "near", "left", "right"] as const) walls.add(wall(side, su.halfWidth, su.halfLength, height, mat));
    group.add(walls);
  }

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
    dispose: () => disposeAll(group, extra),
  };
}

// ---------------------------------------------------------------------------
// The stadium.

export const STADIUM_URL = "/venues/parque-roca.glb";
/** CC-BY-4.0 asks for this wherever the model is shown. */
export const STADIUM_CREDIT = {
  text: "Stadium: “Estadio Parque Roca” by A1905, CC BY 4.0",
  href: "https://sketchfab.com/3d-models/estadio-parque-roca-35eff25bb57f4cf1b8209e6fd2abc164",
};

// Where the model's court is, in the model's own frame (metres, y up): the
// net's line and the centre line, read off its clay texture and net. Its long
// axis runs along the model's x.
const MODEL_CENTRE = new THREE.Vector3(200.53, 0.91, -40.71);
// What to leave out: its clay (the recorded court goes there) and its net
// (Replay3D draws the net every venue shares).
const HIDE = new Set(["material_22", "Fencing", "Color_H0", "Color_I0", "69_iron"]);
// The inner faces of its green walls round the court, measured from the model
// (our court metres; not quite symmetric): beside it for |y| < 22.8, behind it
// for |x| < 8.4.
const WALL = { left: -12.23, right: 12.49, sideLen: 22.8, near: -25.4, far: 25.58, endLen: 8.4 };
// The recorded surface reaches the walls (the model's clay stopped short of them).
const RUN = { w: WALL.right - WALL.left, l: WALL.far - WALL.near };

const OJO_ORANGE = "#d9662c", OJO_GREEN = "#0d3b2a", OJO_CREAM = "#f4f1e8";

/** Our board: dark green, the Ojo mark and name in cream and clay, repeating. */
function ojoBoard(len: number, h: number): THREE.CanvasTexture {
  const px = 96; // per metre
  const cv = document.createElement("canvas");
  const unit = 9; // metres per repeat
  cv.width = unit * px;
  cv.height = Math.round(h * px);
  const g = cv.getContext("2d")!;
  const t = new THREE.CanvasTexture(cv);
  const draw = (logo?: HTMLImageElement) => {
    g.fillStyle = OJO_GREEN;
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = OJO_ORANGE;
    g.fillRect(0, cv.height - 6, cv.width, 6);
    const s = cv.height * 0.62, y = (cv.height - s) / 2 - 3;
    for (const x0 of [0.06, 0.46]) {
      const x = x0 * cv.width;
      if (logo) g.drawImage(logo, x, y, s, s);
      g.fillStyle = OJO_CREAM;
      g.font = `800 ${Math.round(cv.height * 0.5)}px system-ui, -apple-system, "Helvetica Neue", sans-serif`;
      g.textBaseline = "middle";
      g.fillText(x0 < 0.5 ? "OJO" : "OJO TENNIS", x + s + cv.height * 0.22, cv.height / 2 - 2);
    }
    t.needsUpdate = true;
  };
  draw();
  const img = new Image();
  img.onload = () => draw(img);
  img.src = "/logo.svg";
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(len / unit, 1);
  t.anisotropy = 8;
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

export function buildStadium(scene: MatchScene, renderer: THREE.WebGLRenderer): BuiltVenue {
  const group = new THREE.Group();
  const extra: { dispose: () => void }[] = [];
  let gone = false;

  // The recorded surface over the model's clay, shown straight away; the
  // stadium round it arrives when it has loaded.
  videoSurface(scene, renderer, group, RUN.w, RUN.l);
  group.add(flat(400, 400, new THREE.MeshLambertMaterial({ color: 0x6f6a62 }), -0.05)); // until it does

  // Our boards along the foot of the green walls, just in front of them.
  const boardH = 1.1, inset = 0.04;
  const boards: [THREE.Vector3, number, number][] = [
    [S(WALL.left + inset, 0, boardH / 2 + 0.02), Math.PI / 2, 2 * WALL.sideLen],
    [S(WALL.right - inset, 0, boardH / 2 + 0.02), -Math.PI / 2, 2 * WALL.sideLen],
    [S(0, WALL.far - inset, boardH / 2 + 0.02), 0, 2 * WALL.endLen],
    [S(0, WALL.near + inset, boardH / 2 + 0.02), Math.PI, 2 * WALL.endLen],
  ];
  for (const [at, turn, len] of boards) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, boardH), new THREE.MeshLambertMaterial({ map: ojoBoard(len, boardH) }));
    m.position.copy(at);
    m.rotation.y = turn;
    m.receiveShadow = true;
    group.add(m);
  }

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(STADIUM_URL, (gltf) => {
    if (gone) {
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
      return;
    }
    const model = gltf.scene;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.some((mt) => HIDE.has(mt.name))) m.visible = false;
      m.receiveShadow = true;
    });
    // Its court centre to ours, its long axis to ours (model +x -> our +y).
    model.position.copy(MODEL_CENTRE).multiplyScalar(-1);
    const holder = new THREE.Group();
    holder.rotation.y = Math.PI / 2;
    holder.add(model);
    group.add(holder);
  }, undefined, (e) => console.warn("The stadium couldn't load; showing the court on its own.", e));

  const background = skyTexture();
  extra.push(background);
  return {
    group,
    background,
    fog: new THREE.Fog(0xdfe9f1, 160, 420),
    dispose: () => {
      gone = true;
      disposeAll(group, extra);
    },
  };
}
