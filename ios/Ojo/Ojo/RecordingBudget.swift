import Combine
import SwiftUI
import UIKit

/// How long this phone can record for right now: by storage (free space at the
/// recorder's bitrate) and by battery (charge at a cautious drain rate).
///
/// A match is an hour or two, and both run out silently in the middle of one —
/// the recorder stops itself before the disk fills, and a flat phone just dies —
/// so the camera says up front how much of each there is, and warns when either
/// is under an hour.
@MainActor
final class RecordingBudget: ObservableObject {
    /// Seconds of video the free space holds, or nil if it can't be read.
    @Published private(set) var storageSeconds: Int?
    /// Free space on the volume the recording is written to.
    @Published private(set) var freeBytes: Int64?
    /// 0...1, or nil where iOS won't say (the Simulator).
    @Published private(set) var batteryLevel: Float?
    @Published private(set) var charging = false

    /// Below this, either one gets a warning.
    static let enough = 60 * 60

    /// How fast recording drains the battery, as a share of a full charge per
    /// hour. Capturing 1080p, encoding it and writing it out, with the screen
    /// dimmed, costs roughly a fifth of a charge an hour on a recent iPhone and
    /// more on an older or worn battery — so this errs high: better to warn
    /// about a match the phone would have finished than not warn about one it
    /// won't.
    static let drainPerHour: Float = 0.25

    private var timer: AnyCancellable?
    private var battery: AnyCancellable?

    func start() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        refresh()
        // Charge and space both move while the camera is open (and fast while
        // recording), so keep the numbers current.
        timer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()
            .sink { [weak self] _ in self?.refresh() }
        battery = NotificationCenter.default.publisher(for: UIDevice.batteryStateDidChangeNotification)
            .merge(with: NotificationCenter.default.publisher(for: UIDevice.batteryLevelDidChangeNotification))
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refresh() }
    }

    func stop() {
        timer = nil
        battery = nil
    }

    func refresh() {
        storageSeconds = CameraRecorder.recordableSeconds()
        freeBytes = (try? RecordingStore.documentsURL
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage
        let device = UIDevice.current
        batteryLevel = device.batteryLevel >= 0 ? device.batteryLevel : nil
        charging = device.batteryState == .charging || device.batteryState == .full
    }

    /// Seconds of recording the charge covers; nil while charging (not a limit)
    /// or when the level is unknown.
    var batterySeconds: Int? {
        guard !charging, let batteryLevel else { return nil }
        return Int(batteryLevel / Self.drainPerHour * 3600)
    }

    var storageLow: Bool { (storageSeconds ?? .max) < Self.enough }
    var batteryLow: Bool { (batterySeconds ?? .max) < Self.enough }

    /// Whichever runs out first, for the recording screen.
    var remainingSeconds: Int? {
        [storageSeconds, batterySeconds].compactMap { $0 }.min()
    }

    /// What to say when either is under an hour; nil when both are fine.
    var warning: String? {
        var lines: [String] = []
        if storageLow, let s = storageSeconds {
            let free = freeBytes.map { " (\(Self.size($0)) free)" } ?? ""
            lines.append("Storage: room for about \(Self.duration(s))\(free). Upload or delete old matches, or clear space in Settings.")
        }
        if batteryLow, let s = batterySeconds, let level = batteryLevel {
            lines.append("Battery: \(Int((level * 100).rounded()))%, about \(Self.duration(s)) of recording. Plug in or bring a power bank.")
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n\n")
    }

    /// "62 GB", "850 MB".
    static func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// "2 h 40 m", "45 m".
    static func duration(_ seconds: Int) -> String {
        let minutes = seconds / 60
        if minutes >= 600 { return "10 h+" }
        return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) m" : "\(minutes) m"
    }
}

/// Storage and battery as recording time, at the top of the camera before
/// recording starts. Either turns red under an hour.
struct RecordingBudgetPill: View {
    @ObservedObject var budget: RecordingBudget

    var body: some View {
        HStack(spacing: 12) {
            item(icon: "internaldrive",
                 text: storageText,
                 low: budget.storageLow,
                 label: "Storage")
            Rectangle().fill(.white.opacity(0.25)).frame(width: 1, height: 14)
            item(icon: batteryIcon,
                 text: batteryText,
                 low: budget.batteryLow,
                 label: "Battery")
        }
        .font(.caption.weight(.semibold).monospacedDigit())
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(.black.opacity(0.5), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private func item(icon: String, text: String, low: Bool, label: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
            Text(text)
        }
        .foregroundStyle(low ? Theme.danger : .white)
        .accessibilityLabel("\(label): \(text)\(low ? ", under an hour" : "")")
    }

    private var storageText: String {
        let time = budget.storageSeconds.map(RecordingBudget.duration)
        let free = budget.freeBytes.map(RecordingBudget.size)
        return [free, time].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? "–"
    }

    private var batteryText: String {
        if budget.charging { return "Charging" }
        guard let level = budget.batteryLevel else { return "–" }
        let pct = "\(Int((level * 100).rounded()))%"
        return budget.batterySeconds.map { "\(pct) · \(RecordingBudget.duration($0))" } ?? pct
    }

    private var batteryIcon: String {
        if budget.charging { return "battery.100percent.bolt" }
        switch budget.batteryLevel ?? 1 {
        case ..<0.15: return "battery.0percent"
        case ..<0.4: return "battery.25percent"
        case ..<0.65: return "battery.50percent"
        case ..<0.9: return "battery.75percent"
        default: return "battery.100percent"
        }
    }
}
