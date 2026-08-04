export interface MatchVideo {
  id: string;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  durationS: number | null;
  sizeBytes: number;
  createdAt: string;
  thumbnailUrl: string | null;
  /** How this video got into the library: 'share' = added from a link, 'participant' = tagged in it. */
  addedVia: "upload" | "share" | "participant";
}

export const STATUS_LABEL: Record<MatchVideo["status"], string> = {
  uploading: "Uploading",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

export function formatDuration(s: number | null): string {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
