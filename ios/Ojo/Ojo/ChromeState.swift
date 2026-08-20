import Combine
import SwiftUI

/// Whether the app's own chrome should get out of the way.
///
/// The tab bar is drawn by `MainTabView` as a `safeAreaInset`, so a screen pushed
/// inside a tab's navigation stack can't remove it the way `.toolbar(.hidden,
/// for: .tabBar)` would with a system `TabView`. This is the channel for saying
/// so: the immersive Watch screen sets it, the tab bar reads it.
@MainActor
final class ChromeState: ObservableObject {
    static let shared = ChromeState()

    /// Set while a fullscreen/landscape surface is on screen.
    @Published var tabBarHidden = false

    private init() {}
}
