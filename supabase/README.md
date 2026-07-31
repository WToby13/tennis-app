# Supabase — auth + metadata setup

Supabase provides magic-link auth and the Postgres `videos` metadata store. The web
app turns auth on automatically once the two `NEXT_PUBLIC_SUPABASE_*` env vars are set;
with them unset it stays in zero-auth local mode.

## One-time setup

1. **Create a project** at [supabase.com](https://supabase.com) (free tier is plenty).
   Pick a region near you and save the database password somewhere safe.

2. **Run the schema.** In the dashboard: **SQL Editor → New query**, paste the contents
   of [`migrations/0001_init.sql`](migrations/0001_init.sql), and **Run**. This creates
   `profiles` + `videos`, the auto-profile trigger, and all the RLS policies.

3. **Configure auth redirect URLs.** **Authentication → URL Configuration**:
   - **Site URL:** `http://localhost:3000`
   - **Redirect URLs:** add `http://localhost:3000/auth/callback`
     (and later your Vercel URL + `/auth/callback`).

4. **(For the iOS app) enable the 6-digit code.** The magic-link email works for the web
   as-is. iOS signs in with a one-time **code** instead of a deep link, so add the token to
   the email template: **Authentication → Email Templates → Magic Link**, include a line like
   `Your code: {{ .Token }}` alongside the existing link. Then the same email works for both.

5. **Copy your keys** from **Project Settings → API** into `web/.env`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
   ```
   (The anon key is safe for the browser — RLS is what protects the data. The service-role
   key is only needed later for the faststart Lambda.)

6. **Restart `npm run dev`.** Visiting the app now redirects to `/login`; enter your email,
   click the magic link, and you're in. Your uploads are tagged with your user id; you and
   any other signed-in friend can watch each other's matches (per the RLS policies).

## How auth flows through the app

- `middleware.ts` refreshes the session on every request and redirects unauthenticated
  users to `/login` (and returns 401 for `/api/*`).
- API routes resolve a request-scoped Supabase client via `lib/request.ts`, so every
  metadata query runs under the caller's RLS policies.
- `initiate` stamps each new video with `owner_id = auth.uid()`.
