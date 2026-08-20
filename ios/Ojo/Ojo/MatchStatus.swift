import SwiftUI

/// Swift mirror of `web/lib/matchStatus.ts` — the server derives this once and
/// both clients render it, so "shared" and "analysing" can't drift apart between
/// web and iOS. Optional everywhere on this side: a match that only exists on
/// this phone has no server status yet.
struct MatchStatus: Codable, Equatable, Hashable {
    /// uploading | processing | ready | failed
    let upload: String
    /// none | processing | ready | failed
    let analysis: String
    /// private | link | followers | public
    let share: String
}

/// The four-value severity vocabulary shared with the web app's CSS tones.
enum Tone {
    case neutral, progress, good, danger

    var color: Color {
        switch self {
        case .neutral: return Theme.muted
        case .progress: return Theme.accent
        case .good: return Theme.sage
        case .danger: return Theme.danger
        }
    }
}

struct Chip: Equatable {
    let label: String
    let tone: Tone

    static func == (a: Chip, b: Chip) -> Bool { a.label == b.label }
}

/// What the two chips on a match card should say.
///
/// iOS has one state the server can't know about — a match recorded here and not
/// yet uploaded — so the local `Recording.Status` takes precedence, and the
/// server's `MatchStatus` fills in everything after the bytes land.
enum MatchChips {
    /// The "what's happening" chip. `nil` in the steady state (uploaded, idle),
    /// where the share chip carries the card on its own.
    static func activity(_ recording: Recording, _ status: MatchStatus?) -> Chip? {
        switch recording.status {
        case .pending:
            return Chip(label: "Not uploaded", tone: .progress)
        case .uploading:
            return Chip(label: "Uploading", tone: .progress)
        case .failed:
            return Chip(label: "Upload failed", tone: .danger)
        case .uploaded:
            break // fall through to the server's view
        }

        guard let status else { return nil }
        switch status.upload {
        case "uploading": return Chip(label: "Uploading", tone: .progress)
        case "processing": return Chip(label: "Processing", tone: .progress)
        case "failed": return Chip(label: "Upload failed", tone: .danger)
        default: break
        }
        switch status.analysis {
        case "processing": return Chip(label: "Analysing", tone: .progress)
        case "failed": return Chip(label: "Analysis failed", tone: .danger)
        default: return nil
        }
    }

    /// The share chip — `nil` until the match exists in the cloud, since a
    /// recording sitting on this phone isn't shared with anyone by definition.
    static func share(_ recording: Recording, _ status: MatchStatus?) -> Chip? {
        guard recording.status == .uploaded, let status else { return nil }
        switch status.share {
        case "public": return Chip(label: "Public", tone: .good)
        case "followers": return Chip(label: "Shared", tone: .good)
        case "link": return Chip(label: "Link shared", tone: .good)
        default: return Chip(label: "Private", tone: .neutral)
        }
    }
}

/// The actions a match offers, per the state it's in.
///
/// Every state gets two, stacked: getting the match up is one decision (just
/// upload, or upload and have the AI break it down — which needs answers first,
/// so it opens a shelf), and once it's up, watching it and sharing it are
/// separate things you'd want, not one button standing in for both.
enum MatchAction: Hashable {
    /// Send the bytes, nothing more. Still opens the shelf — who played is worth
    /// recording whether or not the AI ever looks at the match.
    case upload
    /// Same, after a failure.
    case retryUpload
    /// Upload and run the AI breakdown with the shelf's answers.
    case aiBreakdown
    /// In flight; the card shows progress instead.
    case uploading
    case watch
    case share

    /// The stack for a match, primary CTA first — it sits at the top of the pair.
    static func stack(for recording: Recording) -> [MatchAction] {
        switch recording.status {
        case .pending: return [.aiBreakdown, .upload]
        case .failed: return [.aiBreakdown, .retryUpload]
        case .uploading: return [.uploading]
        case .uploaded: return [.watch, .share]
        }
    }

    var title: String {
        switch self {
        case .upload: return "Upload"
        case .retryUpload: return "Retry upload"
        case .aiBreakdown: return "AI Breakdown"
        case .uploading: return "Uploading…"
        case .watch: return "Watch"
        case .share: return "Share"
        }
    }

    var systemImage: String {
        switch self {
        case .upload, .retryUpload: return "arrow.up.circle.fill"
        case .aiBreakdown: return "sparkles"
        case .uploading: return "arrow.up.circle"
        case .watch: return "play.circle.fill"
        case .share: return "square.and.arrow.up"
        }
    }

    /// Drawn filled (vs. an outline) — the one action the state is really for.
    var isPrimary: Bool {
        switch self {
        case .aiBreakdown, .watch: return true
        case .upload, .retryUpload, .uploading, .share: return false
        }
    }
}

/// A small pill, matching the web app's `.badge` chip.
struct StatusChip: View {
    let chip: Chip

    var body: some View {
        Text(chip.label.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(0.5)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(chip.tone.color.opacity(0.18), in: Capsule())
            .foregroundStyle(chip.tone.color)
            .lineLimit(1)
    }
}
