"use client";

import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase/client";

/** Header auth controls. Rendered only when auth is enabled (see layout). */
export function AuthNav({ email }: { email: string | null }) {
  const router = useRouter();

  async function signOut() {
    await getSupabaseBrowser().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  if (!email) return null;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {email}
      </span>
      <button className="btn secondary" style={{ padding: "6px 12px" }} onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
