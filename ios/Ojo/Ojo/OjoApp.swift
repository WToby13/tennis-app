import SwiftUI

/// Handles the system relaunch that delivers background-upload completion events.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        BackgroundUploader.shared.resume()
        return true
    }

    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        BackgroundUploader.shared.backgroundCompletion = completionHandler
        BackgroundUploader.shared.resume()
    }
}

@main
struct OjoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .onChange(of: scenePhase) { _, phase in
            // On return to foreground, finalize any uploads that finished while away.
            if phase == .active { BackgroundUploader.shared.resume() }
            // Buffered events go out on both edges: leaving is the last chance
            // before the app may be killed outright, and arriving is the first
            // moment there is likely to be a network again.
            if phase == .active || phase == .background { Analytics.flush() }
        }
    }
}
