# Deploying the web app to Vercel

The web app lives in `web/` (monorepo), talks to your S3 + CloudFront and Supabase.
Deploying makes it reachable by friends and gives the iOS app a stable `https` API URL.

## 1. Import the repo

1. Go to [vercel.com](https://vercel.com) → sign in with **GitHub** (account `WToby13`).
2. **Add New… → Project** → import **`tennis-app`**.
3. **⚠️ Set Root Directory to `web`.** This is the #1 gotcha — the Next.js app isn't at
   the repo root. Click **Edit** next to Root Directory and choose `web`. Framework should
   auto-detect as **Next.js**.

## 2. Environment variables

In the import screen (or Project → Settings → Environment Variables), add every var from
your local `web/.env`. Easiest: open `web/.env`, copy the whole file, and paste it into
Vercel's env var box (it accepts a pasted `.env` and splits it into rows).

These must be present:
`STORAGE_BACKEND=s3`, `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`,
`CLOUDFRONT_PRIVATE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

Then click **Deploy**. Note the URL you get, e.g. `https://tennis-app-xxxx.vercel.app`.

## 3. Tell Supabase + S3 about the new URL

Once you have the Vercel URL:

**Supabase** → Authentication → URL Configuration:
- Add redirect URL: `https://<your-vercel-url>/auth/callback`
- (Optional) set Site URL to the Vercel URL so prod is the default.

**S3 CORS** (so the browser can PUT parts from the deployed origin) — edit
`infra/terraform.tfvars`:
```hcl
allowed_origins = [
  "http://localhost:3000",
  "https://<your-vercel-url>",
]
```
then:
```bash
cd infra && terraform apply
```

## 4. Verify

Open the Vercel URL → sign in via magic link → upload a clip → watch it back.
(The magic-link redirect uses the page's own origin, so it "just works" once the Vercel
URL is in Supabase's redirect list.)

## Notes

- Redeploys happen automatically on every push to `main`.
- If the build fails with "no package.json", the Root Directory isn't set to `web`.
- `web/.env` is gitignored and never deployed — Vercel uses its own env vars.
