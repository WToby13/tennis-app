import SwiftUI

/// Initials avatar — a clay circle with up to two initials. Mirrors the web
/// `Avatar.tsx` placeholder (no photo uploads yet).
struct Avatar: View {
    let name: String?
    var size: CGFloat = 36

    private var initials: String {
        let parts = (name ?? "")
            .split(separator: " ")
            .prefix(2)
            .compactMap { $0.first }
        let s = String(parts).uppercased()
        return s.isEmpty ? "?" : s
    }

    var body: some View {
        Circle()
            .fill(Theme.accent)
            .frame(width: size, height: size)
            .overlay(
                Text(initials)
                    .font(.system(size: size * 0.42, weight: .bold))
                    .foregroundStyle(Theme.text)
            )
    }
}
