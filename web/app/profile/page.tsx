import { redirect } from "next/navigation";

/**
 * The profile lives on the library page now (as a header + an edit modal).
 * Kept as a redirect: the OAuth callback sends first-time users here to set
 * their playing hand, and old links/bookmarks point at it.
 */
export default function ProfilePage() {
  redirect("/matches?edit=profile");
}
