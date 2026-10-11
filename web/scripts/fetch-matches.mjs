// Pull match metadata (+ signed video URLs) for the admin's own analysed recordings.
// node scripts/fetch-matches.mjs <outDir>   (run from web/, reads web/.env)
import fs from "node:fs";
import path from "node:path";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const u = process.env.NEXT_PUBLIC_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: k, Authorization: "Bearer " + k };
const get = async (p) => (await fetch(u + p, { headers: h })).json();
const users = (await get("/auth/v1/admin/users?per_page=200")).users;
const mine = users.filter((x) => x.email === process.env.ADMIN_EMAIL).map((x) => x.id);
const vids = await get(`/rest/v1/videos?select=*&status=eq.ready&deleted_at=is.null&analysis_status=eq.ready&owner_id=in.(${mine.join(",")})&order=created_at.desc`);
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const raw = process.env.CLOUDFRONT_PRIVATE_KEY;
const pk = raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
for (const v of vids) {
  const segs = await get(`/rest/v1/video_segments?select=*&video_id=eq.${v.id}&order=start_s`);
  const url = getSignedUrl({
    url: `https://${process.env.CLOUDFRONT_DOMAIN}/${v.key.split("/").map(encodeURIComponent).join("/")}`,
    keyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID, privateKey: pk,
    dateLessThan: new Date(Date.now() + 24 * 3600e3).toISOString(),
  });
  const rec = {
    id: v.id, title: v.title, durationS: v.duration_s, sizeBytes: v.size_bytes,
    segments: Array.isArray(segs) ? segs.map((s) => ({ kind: s.kind, idx: s.idx, startS: s.start_s, endS: s.end_s, metadata: s.metadata })) : segs,
    calibration: v.court_calibration, url,
  };
  fs.writeFileSync(path.join(out, v.id.slice(0, 8) + ".json"), JSON.stringify(rec));
  console.log(v.id.slice(0, 8), JSON.stringify(v.title), Math.round(v.duration_s ?? 0), "s", Array.isArray(segs) ? segs.length + " segs" : JSON.stringify(segs).slice(0, 120));
}
