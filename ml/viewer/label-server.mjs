// Local server for the labelling page.
//
//   node ml/viewer/label-server.mjs [port]
//
// Serves the page, the downloaded match videos (with Range requests, so the
// browser can seek in a 4 GB file), the pipeline's analysis for reference, and
// reads/writes ground-truth labels in ml/labels/<id>.json.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEOS = path.join(ML, ".cache", "videos");
const MATCHES = path.join(ML, ".cache", "matches");
const LABELS = path.join(ML, "labels");
const ANALYSIS = path.join(ML, "out", "analysis");
const port = Number(process.argv[2] ?? 8766);
const ID = /^[0-9a-f]{8}$/;

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function matches() {
  return fs.readdirSync(VIDEOS)
    .filter((f) => f.endsWith(".mov") || f.endsWith(".mp4"))
    .map((f) => {
      const id = f.slice(0, 8);
      const meta = readJson(path.join(MATCHES, `${id}.json`)) ?? {};
      const labels = readJson(path.join(LABELS, `${id}.json`));
      return { id, file: f, title: meta.title ?? id, durationS: meta.durationS ?? null, labelled: labels?.events?.length ?? 0 };
    });
}

function streamVideo(req, res, file) {
  const { size } = fs.statSync(file);
  const type = file.endsWith(".mp4") ? "video/mp4" : "video/quicktime";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!range) {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : Math.min(start + 8 * 2 ** 20, size - 1);
  res.writeHead(206, {
    "content-type": type,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/" || url.pathname === "/label.html") {
    return send(res, 200, fs.readFileSync(path.join(ML, "viewer", "label.html"), "utf8"), "text/html; charset=utf-8");
  }
  if (url.pathname === "/api/matches") return send(res, 200, matches());
  const [kind, id] = parts;
  if (!id || !ID.test(id)) return send(res, 404, { error: "not found" });
  if (kind === "video") {
    const m = matches().find((x) => x.id === id);
    return m ? streamVideo(req, res, path.join(VIDEOS, m.file)) : send(res, 404, { error: "no video" });
  }
  if (kind === "analysis") {
    const a = readJson(path.join(ANALYSIS, id, "analysis.json"));
    if (!a) return send(res, 200, null);
    // Only what the page shows: rally windows and fitted hits.
    return send(res, 200, {
      fps: a.fps,
      rallies: a.rallies.map((r) => ({ startS: r.startS, endS: r.endS, hits: r.shots.map((s) => ({ t: s.t0, end: s.hitter })) })),
      twelvelabs: (a.twelvelabs ?? []).map((s) => ({ startS: s.startS, endS: s.endS })),
    });
  }
  if (kind === "labels") {
    const file = path.join(LABELS, `${id}.json`);
    if (req.method === "GET") return send(res, 200, readJson(file) ?? { id, events: [] });
    if (req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data.events)) throw new Error("events must be a list");
          fs.mkdirSync(LABELS, { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ ...data, id, savedAt: new Date().toISOString() }, null, 1));
          send(res, 200, { ok: true, events: data.events.length });
        } catch (e) {
          send(res, 400, { error: String(e.message ?? e) });
        }
      });
      return;
    }
  }
  send(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => console.log(`labelling on http://localhost:${port}`));
