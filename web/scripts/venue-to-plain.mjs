#!/usr/bin/env node
/**
 * A venue model for the iOS app: the web's meshopt-compressed GLB, unpacked to
 * plain glTF that a small reader can take without a meshopt decoder.
 *
 *   node web/scripts/venue-to-plain.mjs web/public/venues/parque-roca.glb \
 *        ios/Ojo/Ojo/Venues/parque-roca.plain.glb
 *
 * - meshopt-compressed buffer views decoded (EXT_meshopt_compression);
 * - quantized attributes made float32 (KHR_mesh_quantization), with each node's
 *   transform baked into its positions and normals, so every mesh sits in the
 *   model's own frame with an identity node;
 * - indices widened to uint32; tangents and other extras dropped;
 * - materials kept as they were (name, colour, texture, blending, two-sided) —
 *   the app hides some by name, as the web does — and the images as they were.
 */
import fs from "node:fs";
import { MeshoptDecoder } from "meshoptimizer";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: venue-to-plain.mjs <in.glb> <out.glb>");
  process.exit(1);
}

const glb = fs.readFileSync(src);
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));
const binStart = 20 + jsonLen + 8;
const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));

await MeshoptDecoder.ready;

/** A buffer view's bytes, decoded when meshopt-compressed. */
const viewCache = new Map();
function view(i) {
  if (viewCache.has(i)) return viewCache.get(i);
  const bv = gltf.bufferViews[i];
  const ext = bv.extensions?.EXT_meshopt_compression;
  let bytes;
  if (ext) {
    bytes = new Uint8Array(ext.count * ext.byteStride);
    const source = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
    MeshoptDecoder.decodeGltfBuffer(bytes, ext.count, ext.byteStride, source, ext.mode, ext.filter ?? "NONE");
  } else {
    bytes = new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
  }
  viewCache.set(i, bytes);
  return bytes;
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const READ = {
  5120: [1, (d, o) => d.getInt8(o), 127],
  5121: [1, (d, o) => d.getUint8(o), 255],
  5122: [2, (d, o) => d.getInt16(o, true), 32767],
  5123: [2, (d, o) => d.getUint16(o, true), 65535],
  5125: [4, (d, o) => d.getUint32(o, true), 4294967295],
  5126: [4, (d, o) => d.getFloat32(o, true), 1],
};

/** An accessor as plain numbers, normalized ones mapped to their real range. */
function read(i) {
  const a = gltf.accessors[i];
  const n = COMPONENTS[a.type];
  const [size, get, max] = READ[a.componentType];
  const bytes = view(a.bufferView);
  const stride = gltf.bufferViews[a.bufferView].byteStride ?? gltf.bufferViews[a.bufferView].extensions?.EXT_meshopt_compression?.byteStride ?? n * size;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const outArr = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) {
    for (let c = 0; c < n; c++) {
      let v = get(dv, (a.byteOffset ?? 0) + k * stride + c * size);
      if (a.normalized) v = Math.max(v / max, -1);
      outArr[k * n + c] = v;
    }
  }
  return outArr;
}

// --- Node transforms (column-major 4x4) -------------------------------------
function matrixOf(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const world = new Map();
function walk(i, parent) {
  const m = mul(parent, matrixOf(gltf.nodes[i]));
  world.set(i, m);
  for (const c of gltf.nodes[i].children ?? []) walk(c, m);
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const root of gltf.scenes[gltf.scene ?? 0].nodes) walk(root, IDENTITY);

// --- Write the plain model ----------------------------------------------------
const chunks = [];
let offset = 0;
const views = [], accessors = [];
function addView(bytes, target) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
  chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  offset += bytes.byteLength;
  return views.length - 1;
}
function addAccessor(arr, type, componentType, target, minmax) {
  const v = addView(arr, target);
  accessors.push({ bufferView: v, componentType, count: arr.length / COMPONENTS[type], type, ...(minmax ?? {}) });
  return accessors.length - 1;
}

const meshes = [], nodes = [];
let triangles = 0;
for (const [ni, m] of world) {
  const node = gltf.nodes[ni];
  if (node.mesh === undefined) continue;
  const prims = [];
  for (const p of gltf.meshes[node.mesh].primitives) {
    if ((p.mode ?? 4) !== 4) continue;
    const pos = read(p.attributes.POSITION);
    const count = pos.length / 3;
    const P = new Float32Array(count * 3);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < count; k++) {
      const [x, y, z] = [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
      for (let r = 0; r < 3; r++) {
        const v = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
        P[k * 3 + r] = v;
        lo[r] = Math.min(lo[r], v); hi[r] = Math.max(hi[r], v);
      }
    }
    const attributes = { POSITION: addAccessor(P, "VEC3", 5126, 34962, { min: lo, max: hi }) };
    if (p.attributes.NORMAL !== undefined) {
      const nor = read(p.attributes.NORMAL);
      const N = new Float32Array(count * 3);
      // Uniform scale and a rotation here, so the upper 3x3 is fine for normals.
      for (let k = 0; k < count; k++) {
        const [x, y, z] = [nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]];
        const v = [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z);
        const len = Math.hypot(...v) || 1;
        for (let r = 0; r < 3; r++) N[k * 3 + r] = v[r] / len;
      }
      attributes.NORMAL = addAccessor(N, "VEC3", 5126, 34962);
    }
    if (p.attributes.TEXCOORD_0 !== undefined) {
      attributes.TEXCOORD_0 = addAccessor(new Float32Array(read(p.attributes.TEXCOORD_0)), "VEC2", 5126, 34962);
    }
    const idx = p.indices !== undefined ? Uint32Array.from(read(p.indices)) : Uint32Array.from({ length: count }, (_, k) => k);
    triangles += idx.length / 3;
    prims.push({ attributes, indices: addAccessor(idx, "SCALAR", 5125, 34963), material: p.material, mode: 4 });
  }
  meshes.push({ name: gltf.meshes[node.mesh].name, primitives: prims });
  nodes.push({ name: node.name, mesh: meshes.length - 1 });
}

// Images: copied byte for byte.
const images = (gltf.images ?? []).map((img) => {
  const bv = view(img.bufferView);
  return { mimeType: img.mimeType, bufferView: addView(new Uint8Array(bv)) };
});

const materials = gltf.materials.map((mt) => {
  const { extensions, ...rest } = mt;
  return rest;
});

const outJson = {
  asset: { version: "2.0", generator: "ojo venue-to-plain", copyright: gltf.asset?.copyright },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes, meshes, materials,
  textures: (gltf.textures ?? []).map((t) => ({ source: t.source, sampler: t.sampler })),
  samplers: gltf.samplers,
  images,
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: offset }],
};

const binOut = Buffer.concat(chunks);
const binPad = Buffer.concat([binOut, Buffer.alloc((4 - (binOut.length % 4)) % 4)]);
let jsonBuf = Buffer.from(JSON.stringify(outJson), "utf8");
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPad.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binPad.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.mkdirSync(new URL(".", `file://${process.cwd()}/${out}`).pathname, { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, jh, jsonBuf, bh, binPad]));
console.log(`${out}: ${meshes.length} meshes, ${Math.round(triangles / 1000)}k triangles, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
