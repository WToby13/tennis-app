import type { AnalysisStatus, VideoStatus, VideoVisibility } from "./metadata/types";

/**
 * The one status model the web app and the iOS app both render.
 *
 * A match has three independent states — where its bytes are, whether the AI has
 * looked at it, and who can see it — and every surface (library card, watch page,
 * iOS row) needs some combination of them. Deriving it once on the server means
 * the two clients can't drift on what "shared" or "processing" means.
 */
export interface MatchStatus {
  /** Where the bytes are: still arriving, being prepared, playable, or broken. */
  upload: VideoStatus;
  /** Whether the AI rally breakdown has run. */
  analysis: AnalysisStatus;
  /** How widely the match is currently shared. */
  share: ShareState;
}

/** How widely a match is shared, least to most visible. */
export type ShareState = "private" | "link" | "followers" | "public";

/** The raw facts a share state is derived from. */
export interface ShareFacts {
  visibility: VideoVisibility;
  /** A live (unrevoked, unexpired) share link exists. */
  hasActiveShareLink: boolean;
  /** The caller posted this match to their followers' feeds. */
  sharedToFollowers: boolean;
}

/** Most-visible state wins: a match posted to a feed reads as shared, link or not. */
export function deriveShareState(f: ShareFacts): ShareState {
  if (f.visibility === "public") return "public";
  if (f.sharedToFollowers) return "followers";
  if (f.hasActiveShareLink || f.visibility === "unlisted") return "link";
  return "private";
}

export function deriveMatchStatus(
  video: { status: VideoStatus; analysisStatus: AnalysisStatus },
  share: ShareFacts,
): MatchStatus {
  return {
    upload: video.status,
    analysis: video.analysisStatus,
    share: deriveShareState(share),
  };
}

// --- presentation -----------------------------------------------------------

/** Severity/colour bucket, so web CSS and SwiftUI can map one vocabulary. */
export type Tone = "neutral" | "progress" | "good" | "danger";

export interface Chip {
  label: string;
  tone: Tone;
}

export const SHARE_CHIP: Record<ShareState, Chip> = {
  private: { label: "Private", tone: "neutral" },
  link: { label: "Link shared", tone: "good" },
  followers: { label: "Shared", tone: "good" },
  public: { label: "Public", tone: "good" },
};

/**
 * The "what's happening right now" chip — upload first, then analysis, since a
 * match that hasn't finished uploading can't be analysed yet.
 *
 * Returns null in the steady state (uploaded and not mid-analysis): there's
 * nothing happening worth a chip, and the share chip carries the card instead.
 */
export function activityChip(status: MatchStatus): Chip | null {
  switch (status.upload) {
    case "uploading":
      return { label: "Uploading", tone: "progress" };
    case "processing":
      return { label: "Processing", tone: "progress" };
    case "failed":
      return { label: "Upload failed", tone: "danger" };
  }
  switch (status.analysis) {
    case "processing":
      return { label: "Analysing", tone: "progress" };
    case "failed":
      return { label: "Analysis failed", tone: "danger" };
  }
  return null;
}

/** Whether the owner can start an AI breakdown right now. */
export function canAnalyse(status: MatchStatus): boolean {
  return status.upload === "ready" && status.analysis !== "processing";
}
