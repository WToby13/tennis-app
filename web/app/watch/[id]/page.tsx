import type { Metadata } from "next";
import { APP_STORE_ID, SITE_URL } from "@/lib/site";
import { WatchPage } from "./WatchPage";

/**
 * The watch page itself is a client component (WatchPage.tsx); this server
 * wrapper exists for what only the server can set per match: Safari's Smart App
 * Banner, pointed at this match. Tapping "Open" on it launches the app with
 * this page's address (share token included), and the app opens the same match
 * (ios/Ojo/Ojo/DeepLinks.swift). Other browsers get AppBanner instead.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { id } = await params;
  const { s } = await searchParams;
  const url = new URL(`/watch/${encodeURIComponent(id)}`, SITE_URL);
  if (typeof s === "string" && s) url.searchParams.set("s", s);
  return { itunes: { appId: APP_STORE_ID, appArgument: url.toString() } };
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <WatchPage params={params} />;
}
