import AVKit
import SwiftUI

/// Full-screen in-app playback of a locally recorded match. Plays straight from
/// the file in Documents, so review works offline and before the clip is uploaded
/// — and local seeking is smooth regardless of the MP4 `moov`/faststart layout.
struct PlayerView: View {
    let url: URL
    let title: String

    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
            } else {
                ProgressView().tint(.white)
            }
        }
        .overlay(alignment: .topLeading) {
            Button(action: { dismiss() }) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 30))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
                    .padding(16)
            }
            .accessibilityLabel("Close player")
        }
        .onAppear {
            let player = AVPlayer(url: url)
            self.player = player
            player.play()
        }
        .onDisappear {
            player?.pause()
        }
    }
}
