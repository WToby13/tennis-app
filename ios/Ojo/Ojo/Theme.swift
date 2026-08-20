import SwiftUI

/// The app's dark clay-court palette — the SwiftUI mirror of the web app's
/// `globals.css` design tokens, so iOS and web read as one product.
enum Theme {
    static let bg = Color(hex: 0x14110D)        // court ink (page background)
    static let surface = Color(hex: 0x1C1813)   // cards / bars
    static let surface2 = Color(hex: 0x26211A)  // raised surfaces
    static let border = Color(hex: 0x332C22)
    static let text = Color(hex: 0xF4EEE4)       // chalk cream
    static let muted = Color(hex: 0xA89C8A)
    static let accent = Color(hex: 0xD9662C)     // clay orange
    static let accentDim = Color(hex: 0xE77A42)  // hover / active
    static let sage = Color(hex: 0x8FB388)       // "ready" / success
    static let danger = Color(hex: 0xE5695B)

    static let radius: CGFloat = 14
    static let radiusSmall: CGFloat = 10
}

extension Color {
    /// Build a Color from a 0xRRGGBB literal (opaque).
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
