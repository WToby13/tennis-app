/**
 * Run the real windowed analysis over a real match, end to end, without the app.
 *
 * Cuts each planned window out of the source with ffmpeg, encodes it exactly as
 * the production proxy would, uploads it, runs the real prompt over it, then
 * merges and smooths the results through the same code the app uses. Prints the
 * per-point output so a bad run can be read directly rather than inferred.
 *
 *   node scripts/window-analysis-test.mjs <videoId> [startSec] [totalSec]
 *
 * With no start/total it does the whole match. Throwaway proxies are deleted on
 * the way out, including on failure.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [videoId, startArg, totalArg] = process.argv.slice(2);
if (!videoId) {
  console.error("usage: node scripts/window-analysis-test.mjs <videoId> [startSec] [totalSec]");
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
// The production modules below read process.env at import time.
Object.assign(process.env, env);

const sb = async (q) => {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${q}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res.json();
};

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });

const mmss = (x) => `${String(Math.floor(x / 60)).padStart(2)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
const counts = (v) =>
  [...v.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join("  ");

const main = async () => {
  const [video] = await sb(`videos?select=id,title,key,duration_s&id=eq.${videoId}`);
  if (!video) throw new Error(`no video ${videoId}`);

  const { storage } = await import("../lib/storage/index.ts");
  const { proxyFfmpegArgs } = await import("../lib/analysisProxy.ts");
  const { buildRallyRequest, RALLY_KIND } = await import("../lib/twelvelabs/rally.ts");
  const { createAnalysisTask, getAnalysisTask } = await import("../lib/twelvelabs/client.ts");
  const { normalizeSegments } = await import("../lib/twelvelabs/types.ts");
  const { smoothTennis } = await import("../lib/twelvelabs/smooth.ts");
  const { planWindows, mergeWindowSegments } = await import("../lib/twelvelabs/windows.ts");

  const start = Number(startArg ?? 0);
  const total = Number(totalArg ?? video.duration_s);
  const windows = planWindows(Math.min(start + total, video.duration_s), start);

  console.log(`match:   ${video.title} (${(video.duration_s / 60).toFixed(1)} min)`);
  console.log(`windows: ${windows.length} × ${windows[0].endS - windows[0].startS}s\n`);

  const store = storage();
  const stamp = Date.now();
  const proxyIds = [];
  const locals = [];

  try {
    const srcUrl = await store.getPlaybackUrl(video.id, video.key);

    // Prepare all windows first so the analyse phase can be timed on its own.
    console.log("[1/2] encoding + uploading windows…");
    for (const [i, w] of windows.entries()) {
      const proxyId = `window-test-${stamp}-${i}`;
      const local = path.join(os.tmpdir(), `${proxyId}.mp4`);
      proxyIds.push(proxyId);
      locals.push(local);
      await run("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-y",
        "-ss", String(w.startS), "-i", srcUrl, "-t", String(w.endS - w.startS),
        ...proxyFfmpegArgs(w.endS - w.startS),
        local,
      ]);
      const { url } = await store.getAnalysisProxyUploadUrl(proxyId);
      const put = await fetch(url, {
        method: "PUT",
        body: fs.readFileSync(local),
        headers: { "content-type": "video/mp4" },
      });
      if (!put.ok) throw new Error(`upload ${put.status}: ${await put.text()}`);
      process.stdout.write(`\r      ${i + 1}/${windows.length}   `);
    }
    console.log("\n");

    // The whole point: every window analysed at the same time.
    console.log("[2/2] analysing all windows concurrently…");
    const t0 = Date.now();
    const results = await Promise.all(
      windows.map(async (w, i) => {
        const url = await store.getAnalysisProxyUrl(proxyIds[i]);
        const task = await createAnalysisTask(buildRallyRequest(url));
        let res;
        for (let n = 0; n < 120; n++) {
          await new Promise((r) => setTimeout(r, 5000));
          res = await getAnalysisTask(task.task_id);
          if (res.status === "ready" || res.status === "failed") break;
        }
        if (res?.status !== "ready") throw new Error(`window ${i} ${res?.status}`);
        const segs = normalizeSegments(res, RALLY_KIND);
        console.log(`      window ${i} [${mmss(w.startS)}-${mmss(w.endS)}]: ${segs.length} rallies`);
        return { window: w, segments: segs };
      }),
    );
    console.log(`      all done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

    const merged = mergeWindowSegments(results);
    const beforeDedupe = results.reduce((n, r) => n + r.segments.length, 0);
    console.log(`merged ${beforeDedupe} → ${merged.length} rallies (${beforeDedupe - merged.length} overlap duplicates dropped)\n`);

    const col = (f) => merged.map((s) => String(s.metadata?.[f]));
    for (const f of ["near_player_role", "near_player_identity", "times_ball_was_hit"]) {
      console.log(`${f.padEnd(22)} ${counts(col(f))}`);
    }
    const seen = col("what_you_see");
    console.log(`${"what_you_see unique".padEnd(22)} ${new Set(seen).size} / ${seen.length}\n`);

    console.log("--- per point ---");
    for (const s of merged) {
      const m = s.metadata ?? {};
      console.log(
        `${mmss(s.startS)}-${mmss(s.endS)}  ${String(m.near_player_role).padEnd(10)}` +
          `${String(m.near_player_identity).padEnd(10)}hits=${String(m.times_ball_was_hit).padEnd(3)}` +
          `${String(m.what_you_see).slice(0, 80)}`,
      );
    }

    console.log("\n--- smoother report ---");
    console.log(JSON.stringify(smoothTennis(merged).report, null, 1));
  } finally {
    await Promise.all(proxyIds.map((p) => store.deleteAnalysisProxy(p).catch(() => {})));
    for (const l of locals) fs.rmSync(l, { force: true });
    console.log("\ncleaned up.");
  }
};

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
