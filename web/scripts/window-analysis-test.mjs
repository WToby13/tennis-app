/**
 * One-off experiment: does the rally analysis degrade because of OUTPUT LENGTH?
 *
 * A 2-minute clip (4 points) came back with four distinct, specific descriptions.
 * A 32-minute match (95 points) came back with four sentences rotated
 * 22/22/22/21 and near_player_role constant. Either the model can't sustain ~95
 * segments of structured output, or it can't read this particular footage.
 *
 * This cuts a short window out of a real match, encodes it exactly as the
 * production proxy would, and runs the real prompt over it. A varied result means
 * length is the cause and the fix is to analyse long matches in windows; a
 * templated result means the footage is the problem.
 *
 *   node scripts/window-analysis-test.mjs <videoId> <startSec> <windowSec>
 *
 * Cleans up the throwaway proxy on the way out, including on failure.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [videoId, startArg, lenArg] = process.argv.slice(2);
if (!videoId) {
  console.error("usage: node scripts/window-analysis-test.mjs <videoId> [startSec] [windowSec]");
  process.exit(1);
}
const START = Number(startArg ?? 600);
const WINDOW = Number(lenArg ?? 300);

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
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });

const main = async () => {
  const [video] = await sb(`videos?select=id,title,key,duration_s&id=eq.${videoId}`);
  if (!video) throw new Error(`no video ${videoId}`);
  console.log(`match: ${video.title} (${(video.duration_s / 60).toFixed(1)} min)`);
  console.log(`window: ${START}s → ${START + WINDOW}s\n`);

  // Import the production modules so the encode and the prompt are the real ones.
  const { storage } = await import("../lib/storage/index.ts");
  const { proxyFfmpegArgs } = await import("../lib/analysisProxy.ts");
  const { buildRallyRequest, RALLY_KIND } = await import("../lib/twelvelabs/rally.ts");
  const { createAnalysisTask, getAnalysisTask } = await import("../lib/twelvelabs/client.ts");
  const { normalizeSegments } = await import("../lib/twelvelabs/types.ts");
  const { smoothTennis } = await import("../lib/twelvelabs/smooth.ts");

  const store = storage();
  const proxyId = `window-test-${Date.now()}`;
  const local = path.join(os.tmpdir(), `${proxyId}.mp4`);

  try {
    const srcUrl = await store.getPlaybackUrl(video.id, video.key);

    // -ss before -i seeks without decoding everything up to it, so only the
    // window is actually fetched over the network.
    console.log("[1/4] encoding window…");
    await run("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y",
      "-ss", String(START), "-i", srcUrl, "-t", String(WINDOW),
      ...proxyFfmpegArgs(WINDOW),
      local,
    ]);
    const bytes = fs.statSync(local).size;
    console.log(`      ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);

    console.log("[2/4] uploading…");
    const { url: putUrl } = await store.getAnalysisProxyUploadUrl(proxyId);
    const put = await fetch(putUrl, {
      method: "PUT",
      body: fs.readFileSync(local),
      headers: { "content-type": "video/mp4" },
    });
    if (!put.ok) throw new Error(`upload ${put.status}: ${await put.text()}`);

    console.log("[3/4] analysing…");
    const task = await createAnalysisTask(buildRallyRequest(await store.getAnalysisProxyUrl(proxyId)));
    let result;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      result = await getAnalysisTask(task.task_id);
      process.stdout.write(`\r      ${result.status} (${(i + 1) * 5}s)   `);
      if (result.status === "ready" || result.status === "failed") break;
    }
    console.log();
    if (result?.status !== "ready") throw new Error(`task ${result?.status}: ${JSON.stringify(result?.error)}`);

    const raw = normalizeSegments(result, RALLY_KIND);
    console.log(`\n[4/4] ${raw.length} rallies in a ${WINDOW / 60}-minute window\n`);

    const col = (f) => raw.map((s) => String(s.metadata?.[f]));
    const counts = (v) =>
      [...v.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}×${n}`)
        .join("  ");
    for (const f of ["near_player_role", "near_player_identity", "times_ball_was_hit"]) {
      console.log(`${f.padEnd(22)} ${counts(col(f))}`);
    }
    const seen = col("what_you_see");
    console.log(`${"what_you_see unique".padEnd(22)} ${new Set(seen).size} / ${seen.length}\n`);

    console.log("--- per point ---");
    for (const s of raw) {
      const m = s.metadata ?? {};
      const t = (x) => `${String(Math.floor(x / 60)).padStart(2)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
      console.log(
        `${t(s.startS)}-${t(s.endS)}  ${String(m.near_player_role).padEnd(10)}` +
          `${String(m.near_player_identity).padEnd(10)}hits=${String(m.times_ball_was_hit).padEnd(3)}` +
          `${String(m.what_you_see).slice(0, 90)}`,
      );
    }

    if (raw.length) {
      console.log("\n--- smoother report ---");
      console.log(JSON.stringify(smoothTennis(raw).report, null, 1));
    }
  } finally {
    await store.deleteAnalysisProxy(proxyId).catch(() => {});
    fs.rmSync(local, { force: true });
    console.log("\ncleaned up.");
  }
};

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
