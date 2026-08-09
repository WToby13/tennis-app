import { redirect } from "next/navigation";

/** Uploading is inline on the library page now. Kept for old links. */
export default function UploadPage() {
  redirect("/matches");
}
