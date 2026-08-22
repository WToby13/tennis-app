import Foundation
import SwiftUI

/// The little markup language a match comment is written in.
///
/// Two things inside a comment body mean more than their own text:
///
///     @[Ada Lovelace](3f0c…-…)   a tagged player
///     12:34                       a moment in the match
///
/// Mentions carry the user's id inline rather than being matched by name after
/// the fact — names are not unique and they change, so an id written at posting
/// time is the only thing that keeps pointing at the person actually tagged. The
/// same markup is parsed by the web app (`web/lib/comments.ts`) and by the
/// notification trigger in Postgres (`0017_notifications.sql`), so all three read
/// a comment the same way.
enum CommentMarkup {
    /// Custom schemes, so a tap on a run of text inside `Text` can be told apart
    /// from a real link someone pasted.
    static let mentionScheme = "ojo-mention"
    static let timestampScheme = "ojo-time"

    /// `@[Display Name](uuid)`, the uuid in full canonical form.
    private static let mention = regex(
        #"@\[([^\]]{1,80})\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)"#
    )

    /// `m:ss` or `h:mm:ss`, not glued to a surrounding word or digit.
    ///
    /// The lookarounds earn their keep: without them "10:30am" reads as a seek to
    /// ten and a half minutes, and a set score written "6:4" is close enough to a
    /// timestamp that the seconds group has to be two digits to keep them apart.
    private static let timestamp = regex(#"(?<![\w:])(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?![\w:])"#)

    private static func regex(_ pattern: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern)
    }

    enum Token: Hashable {
        case text(String)
        case mention(name: String, userId: String)
        case timestamp(label: String, seconds: Double)
    }

    /// Split a body into runs. Mentions are found first and their inner text is
    /// never re-scanned, so a player unlucky enough to be called "12:34" does not
    /// turn their own tag into a seek link.
    static func parse(_ body: String) -> [Token] {
        var out: [Token] = []
        let ns = body as NSString
        var cursor = 0

        let matches = mention?.matches(in: body, range: NSRange(location: 0, length: ns.length)) ?? []
        for m in matches where m.numberOfRanges == 3 {
            appendText(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)),
                       into: &out)
            out.append(.mention(name: ns.substring(with: m.range(at: 1)),
                                userId: ns.substring(with: m.range(at: 2)).lowercased()))
            cursor = m.range.location + m.range.length
        }
        appendText(ns.substring(from: cursor), into: &out)
        return out
    }

    /// Scan one run of ordinary text for timestamps.
    private static func appendText(_ text: String, into out: inout [Token]) {
        guard !text.isEmpty else { return }
        let ns = text as NSString
        var cursor = 0
        let matches = timestamp?.matches(in: text, range: NSRange(location: 0, length: ns.length)) ?? []
        for m in matches {
            if m.range.location > cursor {
                out.append(.text(ns.substring(with: NSRange(location: cursor,
                                                            length: m.range.location - cursor))))
            }
            let label = ns.substring(with: m.range(at: 1))
            out.append(.timestamp(label: label, seconds: seconds(from: label)))
            cursor = m.range.location + m.range.length
        }
        if cursor < ns.length { out.append(.text(ns.substring(from: cursor))) }
    }

    /// Seconds from an `m:ss` / `h:mm:ss` label.
    static func seconds(from label: String) -> Double {
        let parts = label.split(separator: ":").compactMap { Double($0) }
        guard parts.count == 2 || parts.count == 3 else { return 0 }
        return parts.count == 3
            ? parts[0] * 3600 + parts[1] * 60 + parts[2]
            : parts[0] * 60 + parts[1]
    }

    /// The body with mention markup reduced to `@Name` — for one-line previews
    /// (a feed card, a notification row) that aren't rendering the live version.
    static func plainText(_ body: String) -> String {
        parse(body).map { token in
            switch token {
            case .text(let s): return s
            case .mention(let name, _): return "@\(name)"
            case .timestamp(let label, _): return label
            }
        }
        .joined()
    }

    /// How a picked player is written into a draft.
    static func markup(name: String, userId: String) -> String {
        // A bracket inside the name would end the label early and leave the rest
        // as loose text, so it is the one character that cannot survive as-is.
        let clean = name.replacingOccurrences(of: "[", with: "")
            .replacingOccurrences(of: "]", with: "")
            .prefix(80)
        return "@[\(clean)](\(userId))"
    }
}

/// A comment body with its two live bits rendered: tagged players in clay orange
/// that open their profile, and timestamps that play the match from there.
///
/// Built as one `AttributedString` rather than a row of buttons so the text still
/// wraps like text — a tag in the middle of a sentence has to reflow with it.
/// Taps arrive as custom-scheme URLs, which `openURL` intercepts below; nothing
/// ever leaves the app.
struct CommentText: View {
    let text: String
    /// Set on the watch screen, where there's a player above to jump.
    var onSeek: ((Double) -> Void)?
    /// Set where there's a navigation stack to push a profile onto.
    var onMention: ((String) -> Void)?

    var body: some View {
        Text(attributed)
            .font(.subheadline)
            .tint(Theme.accent)
            .environment(\.openURL, OpenURLAction { url in
                switch url.scheme {
                case CommentMarkup.timestampScheme:
                    guard let onSeek else { return .handled }
                    onSeek(Double(url.host() ?? "") ?? 0)
                    return .handled
                case CommentMarkup.mentionScheme:
                    if let id = url.host() { onMention?(id) }
                    return .handled
                default:
                    return .systemAction
                }
            })
    }

    private var attributed: AttributedString {
        var out = AttributedString()
        for token in CommentMarkup.parse(text) {
            switch token {
            case .text(let s):
                var run = AttributedString(s)
                run.foregroundColor = Theme.text
                out.append(run)
            case .mention(let name, let userId):
                out.append(highlighted("@\(name)",
                                       scheme: CommentMarkup.mentionScheme,
                                       value: userId))
            case .timestamp(let label, let seconds):
                out.append(highlighted(label,
                                       scheme: CommentMarkup.timestampScheme,
                                       value: String(Int(seconds))))
            }
        }
        return out
    }

    private func highlighted(_ string: String, scheme: String, value: String) -> AttributedString {
        var run = AttributedString(string)
        run.foregroundColor = Theme.accent
        run.font = .subheadline.weight(.semibold)
        run.underlineStyle = nil
        run.link = URL(string: "\(scheme)://\(value)")
        return run
    }
}
