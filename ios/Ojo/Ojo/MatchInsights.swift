import Combine
import Foundation
import SwiftUI

// MARK: - Wire types (mirror web/lib/matchStats.ts and web/lib/matchScene.ts)

/// Our own analysis of a match (the ml/ pipeline), as stored in
/// `match_analyses.data` and served by `/api/videos/:id/match-stats`.
///
/// Court coordinates are metres from centre court: +x to the camera's right, +y
/// away from the camera. "near" is the camera end. Players A and B are told
/// apart by their kit, so their numbers follow them across changes of ends.
/// Every number decodes as `Double`: the pipeline writes `1689.0` and `113`
/// alike, and an Int field would fail on the first float.
struct MatchStats: Decodable {
    let version: String
    let durationS: Double
    /// Every hit found. `shots` are the ones whose flight fitted.
    let hits: Double?
    /// Points played.
    let points: Double?
    let shots: [StatsShot]
    let rallies: [StatsRally]
    let near: PlayerStats
    let far: PlayerStats
    let people: [String: PlayerStats]?
    let games: [StatsGame]?
    let movement: Movement?
}

struct PlayerStats: Decodable {
    let shots: Double
    let serves: Double
    let serveAvg: Double?
    let serveMax: Double?
    let shotAvg: Double?
    let shotMax: Double?
    let inPct: Double?
    let netPct: Double?
    let distance: Double
    let pointsServed: Double?
    let firstServeIn: Double?
    /// Shirt and shorts colour, as hex.
    let swatch: [String]?
}

struct StatsShot: Decodable {
    let rally: Int
    let serve: Bool
    /// "near" | "far"
    let hitter: String
    /// "A" | "B"
    let player: String?
    /// Seconds into the video.
    let t: Double
    let speed: Double
    let bounce: [Double]?
    /// Where it was struck, metres.
    let from: [Double]?
    /// "serving" | "receiving"
    let role: String?
    /// "forehand" | "backhand" — not detected yet.
    let stroke: String?
    /// "in" | "out" | "close" | "net"
    let landing: String?
    let net: Double?
    let doubt: String?
}

struct StatsRally: Decodable {
    let idx: Int
    let start: Double
    let end: Double
    let shots: Double
    let avgSpeed: Double?
    let maxSpeed: Double?
    let run: Double
    let intensity: Double
    let high: Bool
}

struct StatsGame: Decodable {
    let game: Int
    let server: String
    let serverEnd: String
    let start: Double
    let points: Double
    let changeoverAfter: Bool
}

/// Where players stood during play: sampled positions on a grid over their own
/// half, every player turned to the camera end. Keyed "A:serving", "near:any", …
struct Movement: Decodable {
    let cell: Double
    let x0: Double
    let y0: Double
    let nx: Int
    let ny: Int
    let grids: [String: [Double]]
}

/// What the watch page draws over the video, in pixels of the source video.
struct MatchTracks: Decodable {
    let fps: Double
    let width: Double
    let height: Double
    let ball: Ball
    let players: Players
    let bounces: [Bounce]

    struct Ball: Decodable {
        let f: [Int]
        let u: [Double]
        let v: [Double]
    }

    struct Players: Decodable {
        let f: [Int]
        let side: [String]
        let who: [String]
        let box: [[Double]]
    }

    struct Bounce: Decodable {
        let t: Double
        let u: Double
        let v: Double
        let speed: Double
        let landing: String?
        let who: String
    }
}

/// A match as a 3D scene (ml/ojo_replay/scene.py). Metres from centre court on
/// the ground, +x to the camera's right, +y away from the camera, +z up;
/// positions are integer centimetres, flattened; times are seconds of video.
struct MatchScene: Decodable {
    let version: Int
    let fps: Double
    let camera: Camera
    let court: Court?
    /// What the phone saw round the court (scene version 3): the clean plate,
    /// which the 3D view paints onto walls at the fences, and the sky's colour.
    let surroundings: Surroundings?
    /// What the skeletons were lifted with, or nil when there are none.
    let body: String?
    let rallies: [Rally]

    struct Camera: Decodable {
        let position: [Double]
        /// Court → camera rotation, row-major 3×3.
        let rotation: [Double]
        let f: Double
        let cx: Double
        let cy: Double
        let width: Double
        let height: Double
    }

    /// The real court's surface, top-down, centred: row 0 is the far end.
    struct Court: Decodable {
        let texture: String
        let halfWidth: Double
        let halfLength: Double
    }

    struct Surroundings: Decodable {
        /// JPEG data URL of the clean plate (the video with nobody in it).
        let plate: String
        let halfWidth: Double
        let halfLength: Double
        /// RGB, 0–255.
        let sky: [Double]
    }

    struct Shot: Decodable {
        let hitter: String
        let t0: Double
        let t1: Double
        let speed: Double
        let landing: String?
        /// [t, x, y]
        let bounce: [Double]?
        let net: Double?
        let doubt: String?
        /// x, y, z (cm) per video frame from t0.
        let path: [Float]
    }

    struct Player: Decodable {
        let f: [Int]
        let feet: [Float]
        let skeleton: Skeleton?
    }

    /// Hips as base64 int16 cm (xyz) per frame, and 17 joints as base64 int8 cm
    /// offsets from the hips (Human3.6M order).
    struct Skeleton: Decodable {
        let f: [Int]
        let root: String
        let joints: String
    }

    struct Rally: Decodable {
        let idx: Int
        let start: Double
        let end: Double
        /// Which player (A/B) was at each end, "" if unknown.
        let who: [String: String]
        let shots: [Shot]
        let players: [String: Player]
    }
}

// MARK: - API

/// The stats route answers `{stats: null}` for a match nobody has analysed, so
/// absence isn't an error — but a payload that doesn't parse shouldn't take the
/// whole Watch screen's request down with it either.
private struct MatchStatsResponse: Decodable {
    let stats: MatchStats?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        do {
            stats = try c.decodeIfPresent(MatchStats.self, forKey: .stats)
        } catch {
            print("[insights] match-stats didn't parse: \(error)")
            stats = nil
        }
    }

    enum CodingKeys: String, CodingKey { case stats }
}

private struct MatchTracksResponse: Decodable { let tracks: MatchTracks? }

/// Either the scene inline (development files) or where to fetch it from.
private struct MatchSceneResponse: Decodable {
    let url: String?
    let scene: MatchScene?
}

extension UploadAPI {
    /// The match's own analysis, or nil when it hasn't had one.
    func getMatchStats(videoId: String) async throws -> MatchStats? {
        let resp: MatchStatsResponse = try await send("/api/videos/\(videoId)/match-stats", method: "GET")
        return resp.stats
    }

    /// What to draw over the video, or nil.
    func getMatchTracks(videoId: String) async throws -> MatchTracks? {
        let resp: MatchTracksResponse = try await send("/api/videos/\(videoId)/match-tracks", method: "GET")
        return resp.tracks
    }

    /// The 3D scene, fetched straight from storage (a few MB). Nil when the
    /// match has none.
    func getMatchScene(videoId: String) async throws -> MatchScene? {
        let resp: MatchSceneResponse = try await send("/api/videos/\(videoId)/match-scene", method: "GET")
        if let scene = resp.scene { return scene }
        guard let url = resp.url.map(absolutePartURL) else { return nil }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw UploadError.badResponse
        }
        return try JSONDecoder().decode(MatchScene.self, from: data)
    }
}

// MARK: - Model

/// Everything our own analysis has to show for one match: the numbers (loaded
/// with the screen), and the tracking and the 3D scene (loaded the first time
/// someone asks for them — the scene is megabytes).
@MainActor
final class InsightsModel: ObservableObject {
    enum LoadState: Equatable { case idle, loading, loaded, none, failed }

    @Published private(set) var stats: MatchStats?
    @Published private(set) var tracks: MatchTracks?
    @Published private(set) var scene: MatchScene?
    @Published private(set) var tracksState: LoadState = .idle
    @Published private(set) var sceneState: LoadState = .idle

    private(set) var videoId: String?
    private let api = UploadAPI()

    var hasAnalysis: Bool { stats != nil }

    /// Fetch the numbers. Safe to call again — after a breakdown finishes, say —
    /// and only replaces what's shown when something actually came back.
    func load(videoId: String) async {
        if self.videoId != videoId {
            self.videoId = videoId
            stats = nil; tracks = nil; scene = nil
            tracksState = .idle; sceneState = .idle
        }
        if let fresh = try? await api.getMatchStats(videoId: videoId) {
            stats = fresh
        }
    }

    func loadTracks() async {
        guard let videoId, tracksState != .loading, tracks == nil else { return }
        tracksState = .loading
        do {
            tracks = try await api.getMatchTracks(videoId: videoId)
            tracksState = tracks == nil ? .none : .loaded
        } catch {
            tracksState = .failed
        }
    }

    func loadScene() async {
        guard let videoId, sceneState != .loading, scene == nil else { return }
        sceneState = .loading
        do {
            scene = try await api.getMatchScene(videoId: videoId)
            sceneState = scene == nil ? .none : .loaded
        } catch {
            print("[insights] scene failed: \(error)")
            sceneState = .failed
        }
    }
}

/// The two players' colours, everywhere the analysis draws them — the same pair
/// the web uses, so a match reads the same on both.
enum PlayerColor {
    static let a = Color(hex: 0xF0954E)
    static let b = Color(hex: 0x64A2EC)
    static let unknown = Color(hex: 0xD8D2C6)

    static func of(_ who: String?) -> Color {
        switch who {
        case "A", "near": return a
        case "B", "far": return b
        default: return unknown
        }
    }
}

/// Line calls, coloured as on the web's tracking overlay.
enum CallColor {
    static func of(_ landing: String?) -> Color {
        switch landing {
        case "in": return Color(hex: 0x7FD18B)
        case "close": return Color(hex: 0xF2C14E)
        case "out": return Color(hex: 0xEF6F62)
        default: return Color(hex: 0xD8D2C6)
        }
    }
}
