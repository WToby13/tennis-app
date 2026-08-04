import { redirect } from "next/navigation";

/** Legacy path — sign-in now lives at /sign-in. Preserve any `next`. */
export default async function LoginRedirect({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  redirect(`/sign-in${next ? `?next=${encodeURIComponent(next)}` : ""}`);
}
