import AVFoundation
import Combine
import SceneKit
import SwiftUI
import UIKit
import simd

/// The match in 3D (the native form of web/app/Replay3D.tsx): the court wearing
/// the real court's surface, both players, and the ball's flights and bounces,
/// rebuilt by our analysis. The video stays the clock — whatever plays, scrubs,
/// frame-steps or slows the video moves the scene, so the player's own controls
/// drive it.
///
/// Views ease the camera between presets; dragging takes over (free orbit).
/// "Phone" looks through the calibrated phone itself, drawn over the video it was
/// calibrated on — which is also how to check the rebuild lines up.
enum Replay3DView: String, CaseIterable, Identifiable {
    case phone, broadcast, hitter, side, top, free

    var id: String { rawValue }

    var label: String {
        switch self {
        case .phone: return "Phone"
        case .broadcast: return "Broadcast"
        case .hitter: return "Behind the hitter"
        case .side: return "Side on"
        case .top: return "Top down"
        case .free: return "Free"
        }
    }

    /// The presets offered as buttons ("free" is where dragging takes you).
    static let presets: [Replay3DView] = [.phone, .broadcast, .hitter, .side, .top]
}

/// Owns the SceneKit scene and moves it every display frame from the player's
/// clock. Observable so the camera picker and the caption can live anywhere on
/// screen — under the video in portrait, over it in fullscreen.
@MainActor
final class Replay3DController: ObservableObject {
    @Published var view: Replay3DView = .broadcast
    /// Where the match is played: the court it was recorded on, or the stadium.
    @Published var venue: Venue = .court
    /// What the ball is doing right now, in a line.
    @Published private(set) var hud = ""

    let matchScene: MatchScene
    let player: AVPlayer
    let scnView = SCNView()

    private let world = SCNScene()
    private let ground = SCNNode()
    private var builtVenue: (venue: Venue, built: BuiltVenue)?
    private let cameraNode = SCNNode()
    private var figures: [String: Figure] = [:]
    private let ball = SCNNode()
    private let ballShadow = SCNNode()
    private let trailNode = SCNNode()
    private var rallyNodes: [(node: SCNNode, shotIndex: Int, kind: RallyNodeKind)] = []
    private var rallyIndex = -1
    private var skeletons: [String: [Float]] = [:]
    nonisolated(unsafe) private var displayLink: CADisplayLink?
    private lazy var trailMaterial = Self.material(Self.ballColour, lit: false)

    // Camera state: the eased preset's goal, the orbit when free.
    private var target = SIMD3<Float>(0, 0, 0)
    private var goalPos = SIMD3<Float>(0, 0, 0)
    private var goalTarget = SIMD3<Float>(0, 0, 0)
    private var orbit = (yaw: Float(0), pitch: Float(0.3), distance: Float(20))
    private var lastView: Replay3DView?
    private var hitterEnd = "near"
    private var hitterX: Float = 0, hitterY: Float = -11.885
    private var lastSize: CGSize = .zero

    private enum RallyNodeKind { case arc, ring }

    // Court metres. x across, y away from the phone, z up.
    private enum C {
        static let hl: Float = 11.885, sv: Float = 6.4, d: Float = 5.485, sg: Float = 4.115
        static let post: Float = 6.4, postH: Float = 1.07, netC: Float = 0.914
    }

    private static let skyColour = UIColor(Theme.bg)
    private static let ballColour = UIColor(red: 0xE8 / 255, green: 0xF2 / 255, blue: 0x4A / 255, alpha: 1)
    private static let lineColour = UIColor(red: 0xF6 / 255, green: 0xEF / 255, blue: 0xE4 / 255, alpha: 0.85)
    private static let trailFrames = 9
    private static let ease: Float = 0.08
    /// Frames across which a player's lost detections are bridged (scene.py BRIDGE).
    private static let bridge = 30

    init(scene: MatchScene, player: AVPlayer) {
        matchScene = scene
        self.player = player
        build()
    }

    deinit {
        displayLink?.invalidate()
    }

    /// Court metres → SceneKit (y up), as three.js has it.
    private static func S(_ x: Float, _ y: Float, _ z: Float) -> SIMD3<Float> { SIMD3(x, z, -y) }

    // MARK: Lifecycle

    /// How many screens are showing the scene right now.
    ///
    /// The page and fullscreen share one scene, and going fullscreen brings the
    /// new screen up before the old one goes: the old one's "stop" used to land
    /// after the new one's "start", leaving the 3D view frozen on its last frame.
    private var hosts = 0

    /// A screen showing the scene appeared: keep it moving.
    func attach() {
        hosts += 1
        start()
    }

    /// A screen showing the scene went away: stop only when none are left.
    func detach() {
        hosts = max(0, hosts - 1)
        if hosts == 0 { stop() }
    }

    func start() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: DisplayLinkProxy { [weak self] in self?.tick() },
                                 selector: #selector(DisplayLinkProxy.fire))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    // MARK: Building the scene

    private func build() {
        scnView.scene = world
        scnView.backgroundColor = Self.skyColour
        scnView.antialiasingMode = .multisampling4X
        scnView.rendersContinuously = true
        scnView.preferredFramesPerSecond = 60
        world.background.contents = Self.skyColour
        world.fogColor = Self.skyColour
        world.fogStartDistance = 45
        world.fogEndDistance = 110
        world.fogDensityExponent = 1

        let camera = SCNCamera()
        camera.fieldOfView = 45
        camera.zNear = 0.1
        camera.zFar = 300
        cameraNode.camera = camera
        world.rootNode.addChildNode(cameraNode)
        scnView.pointOfView = cameraNode

        // Lights: a warm sky, a sun that casts the players' shadows, and a softer
        // fill from the far end so a player seen from there isn't a silhouette.
        let ambient = SCNNode()
        ambient.light = SCNLight()
        ambient.light!.type = .ambient
        ambient.light!.color = UIColor(red: 1, green: 0.93, blue: 0.85, alpha: 1)
        ambient.light!.intensity = 420
        world.rootNode.addChildNode(ambient)

        let sun = SCNNode()
        sun.light = SCNLight()
        sun.light!.type = .directional
        sun.light!.intensity = 750
        sun.light!.castsShadow = true
        sun.light!.shadowMode = .deferred
        sun.light!.shadowColor = UIColor.black.withAlphaComponent(0.45)
        sun.light!.shadowRadius = 4
        sun.light!.orthographicScale = 24
        sun.light!.shadowMapSize = CGSize(width: 2048, height: 2048)
        sun.simdPosition = SIMD3(-10, 28, 8)
        sun.simdLook(at: .zero)
        world.rootNode.addChildNode(sun)

        let fill = SCNNode()
        fill.light = SCNLight()
        fill.light!.type = .directional
        fill.light!.intensity = 260
        fill.simdPosition = SIMD3(8, 14, -24)
        fill.simdLook(at: .zero)
        world.rootNode.addChildNode(fill)

        world.rootNode.addChildNode(ground)
        buildCourt()
        setVenue(venue)

        for side in ["near", "far"] { figures[side] = Figure(parent: world.rootNode) }

        // Ball: the ball, its shadow on the court, and a trail behind it.
        let sphere = SCNSphere(radius: 0.07)
        sphere.firstMaterial = Self.material(Self.ballColour, lit: false)
        ball.geometry = sphere
        ball.castsShadow = true
        world.rootNode.addChildNode(ball)
        let disc = SCNCylinder(radius: 0.08, height: 0.001)
        disc.firstMaterial = Self.material(UIColor.black.withAlphaComponent(0.4), lit: false)
        ballShadow.geometry = disc
        world.rootNode.addChildNode(ballShadow)
        world.rootNode.addChildNode(trailNode)

        presetFor(.broadcast)
        cameraNode.simdPosition = goalPos
        target = goalTarget
        aim()
    }

    private static func material(_ colour: UIColor, lit: Bool = true, doubleSided: Bool = false) -> SCNMaterial {
        let m = SCNMaterial()
        m.diffuse.contents = colour
        m.lightingModel = lit ? .lambert : .constant
        m.isDoubleSided = doubleSided
        if colour.cgColor.alpha < 1 {
            m.transparency = colour.cgColor.alpha
            m.diffuse.contents = colour.withAlphaComponent(1)
            m.writesToDepthBuffer = false
        }
        return m
    }

    private func flat(width: Float, length: Float, material: SCNMaterial, height: Float) -> SCNNode {
        let plane = SCNPlane(width: CGFloat(width), height: CGFloat(length))
        plane.firstMaterial = material
        let node = SCNNode(geometry: plane)
        node.eulerAngles.x = -.pi / 2
        node.simdPosition.y = height
        return node
    }

    /// What every venue shares: the lines and the net. The venue (`setVenue`)
    /// supplies the surface and everything round it.
    private func buildCourt() {
        let lineMat = Self.material(Self.lineColour, lit: false)
        let line = { (x1: Float, y1: Float, x2: Float, y2: Float, w: Float) in
            let along = abs(x2 - x1) > abs(y2 - y1)
            let len = hypot(x2 - x1, y2 - y1) + w
            let node = self.flat(width: along ? len : w, length: along ? w : len, material: lineMat, height: 0.003)
            let mid = Self.S((x1 + x2) / 2, (y1 + y2) / 2, 0.003)
            node.simdPosition = mid
            self.ground.addChildNode(node)
        }
        let lines: [(Float, Float, Float, Float, Float)] = [
            (-C.d, C.hl, C.d, C.hl, 0.08), (-C.d, -C.hl, C.d, -C.hl, 0.08),
            (-C.d, -C.hl, -C.d, C.hl, 0.05), (C.d, -C.hl, C.d, C.hl, 0.05),
            (-C.sg, -C.hl, -C.sg, C.hl, 0.05), (C.sg, -C.hl, C.sg, C.hl, 0.05),
            (-C.sg, C.sv, C.sg, C.sv, 0.05), (-C.sg, -C.sv, C.sg, -C.sv, 0.05),
            (0, -C.sv, 0, C.sv, 0.05), (0, C.hl, 0, C.hl - 0.1, 0.05), (0, -C.hl, 0, -C.hl + 0.1, 0.05),
        ]
        for l in lines { line(l.0, l.1, l.2, l.3, l.4) }

        // The net, its tape and the posts.
        let path = UIBezierPath()
        path.move(to: CGPoint(x: -CGFloat(C.post), y: 0))
        path.addLine(to: CGPoint(x: CGFloat(C.post), y: 0))
        path.addLine(to: CGPoint(x: CGFloat(C.post), y: CGFloat(C.postH)))
        path.addQuadCurve(to: CGPoint(x: -CGFloat(C.post), y: CGFloat(C.postH)),
                          controlPoint: CGPoint(x: 0, y: CGFloat(2 * C.netC - C.postH)))
        path.close()
        let net = SCNShape(path: path, extrusionDepth: 0.005)
        net.firstMaterial = Self.material(UIColor(red: 0.08, green: 0.07, blue: 0.06, alpha: 0.6), lit: false, doubleSided: true)
        ground.addChildNode(SCNNode(geometry: net))

        let tapeMat = Self.material(UIColor(red: 0.96, green: 0.95, blue: 0.92, alpha: 1))
        let steps = 16
        let curve = { (k: Int) -> SIMD3<Float> in
            let t = Float(k) / Float(steps)
            let x = (1 - t) * (1 - t) * -C.post + t * t * C.post
            let z = (1 - t) * (1 - t) * C.postH + 2 * (1 - t) * t * (2 * C.netC - C.postH) + t * t * C.postH
            return Self.S(x, 0, z)
        }
        for k in 0..<steps {
            let a = curve(k), b = curve(k + 1)
            ground.addChildNode(Self.segment(from: a, to: b, radius: 0.025, material: tapeMat))
        }
        let postMat = Self.material(UIColor(white: 0.87, alpha: 1))
        for x in [-C.post, C.post] {
            let post = SCNNode(geometry: SCNCylinder(radius: 0.04, height: CGFloat(C.postH)))
            post.geometry?.firstMaterial = postMat
            post.simdPosition = Self.S(x, 0, C.postH / 2)
            post.castsShadow = true
            ground.addChildNode(post)
        }
    }

    /// Swap what's round the court. Background, fog and how far the camera
    /// sees follow the venue (applied by `applyView`).
    private func setVenue(_ v: Venue) {
        guard builtVenue?.venue != v else { return }
        builtVenue?.built.node.removeFromParentNode()
        let built = v == .stadium ? VenueBuilder.stadium(matchScene) : VenueBuilder.recordedCourt(matchScene)
        ground.addChildNode(built.node)
        builtVenue = (v, built)
        lastView = nil
    }

    private static func segment(from a: SIMD3<Float>, to b: SIMD3<Float>, radius: CGFloat, material: SCNMaterial) -> SCNNode {
        let d = b - a
        let node = SCNNode(geometry: SCNCylinder(radius: radius, height: CGFloat(simd_length(d))))
        node.geometry?.firstMaterial = material
        node.simdPosition = (a + b) / 2
        node.simdOrientation = simd_quatf(from: SIMD3(0, 1, 0), to: simd_normalize(d))
        return node
    }

    // MARK: Players

    /// One player: a skeleton (bones and joints) where it could be lifted, a
    /// plain standing figure at their feet where it couldn't, and a ring on the
    /// ground under them — who's where, readable from any height.
    private final class Figure {
        // Human3.6M: hip, r_hip, r_knee, r_foot, l_hip, l_knee, l_foot, spine,
        // thorax, neck, head, l_shoulder, l_elbow, l_wrist, r_shoulder, r_elbow, r_wrist.
        static let bonePairs = [(0, 1), (1, 2), (2, 3), (0, 4), (4, 5), (5, 6), (0, 7), (7, 8), (8, 9), (9, 10),
                                (8, 11), (11, 12), (12, 13), (8, 14), (14, 15), (15, 16)]
        static let head = 10

        let group = SCNNode()
        let material = SCNMaterial()
        let ringMaterial = SCNMaterial()
        var bones: [SCNNode] = []
        var joints: [SCNNode] = []
        let plain: SCNNode
        let ring: SCNNode

        init(parent: SCNNode) {
            material.lightingModel = .lambert
            ringMaterial.lightingModel = .constant
            ringMaterial.transparency = 0.85
            ringMaterial.writesToDepthBuffer = false
            let bone = SCNCylinder(radius: 0.045, height: 1)
            bone.firstMaterial = material
            bones = Self.bonePairs.map { _ in
                let n = SCNNode(geometry: bone)
                n.castsShadow = true
                return n
            }
            let joint = SCNSphere(radius: 0.055)
            joint.firstMaterial = material
            let headGeo = SCNSphere(radius: 0.12)
            headGeo.firstMaterial = material
            joints = (0..<17).map { i in
                let n = SCNNode(geometry: i == Self.head ? headGeo : joint)
                n.castsShadow = true
                return n
            }
            let capsule = SCNCapsule(capRadius: 0.22, height: 1.69)
            capsule.firstMaterial = material
            plain = SCNNode(geometry: capsule)
            plain.castsShadow = true
            let tube = SCNTube(innerRadius: 0.42, outerRadius: 0.55, height: 0.004)
            tube.firstMaterial = ringMaterial
            ring = SCNNode(geometry: tube)
            for n in bones + joints + [plain, ring] { group.addChildNode(n) }
            parent.addChildNode(group)
        }

        func setColour(_ c: UIColor) {
            material.diffuse.contents = c
            ringMaterial.diffuse.contents = c
        }
    }

    private static func uiColour(_ who: String?) -> UIColor { UIColor(PlayerColor.of(who)) }

    /// A skeleton's joints in court cm, 17 × xyz per frame (hips + offsets).
    private static func decodeJoints(_ sk: MatchScene.Skeleton) -> [Float]? {
        guard let rootData = Data(base64Encoded: sk.root), let jointData = Data(base64Encoded: sk.joints) else { return nil }
        let root: [Int16] = rootData.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)).map { Int16(littleEndian: $0) } }
        let offsets: [Int8] = jointData.withUnsafeBytes { Array($0.bindMemory(to: Int8.self)) }
        guard root.count * 17 >= offsets.count else { return nil }
        var out = [Float](repeating: 0, count: offsets.count)
        for i in 0..<offsets.count {
            out[i] = Float(root[(i / 51) * 3 + (i % 3)]) + Float(offsets[i])
        }
        return out
    }

    private func pose(_ side: String, frame: Double, rally: MatchScene.Rally) {
        guard let fig = figures[side] else { return }
        fig.group.isHidden = true
        guard let p = rally.players[side] else { return }

        if let sk = p.skeleton, !sk.f.isEmpty {
            let key = "\(rally.idx):\(side)"
            if skeletons[key] == nil { skeletons[key] = Self.decodeJoints(sk) ?? [] }
            let J = skeletons[key] ?? []
            let i = floorIndex(sk.f, frame) { Double($0) }
            let j = min(i + 1, sk.f.count - 1)
            if !J.isEmpty, (i >= 0 && frame - Double(sk.f[i]) <= 4) || (i < 0 && Double(sk.f[0]) - frame <= 2) {
                let a = max(i, 0)
                // Blend between lifted frames, not across a gap where they were lost.
                let span = Double(sk.f[j] - sk.f[a])
                let w = Float(j > a && span <= 6 ? min(max((frame - Double(sk.f[a])) / span, 0), 1) : 0)
                var pts = [SIMD3<Float>](repeating: .zero, count: 17)
                for q in 0..<17 {
                    let o0 = (a * 17 + q) * 3, o1 = (j * 17 + q) * 3
                    guard o1 + 2 < J.count else { continue }
                    let x = ((1 - w) * J[o0] + w * J[o1]) / 100
                    let y = ((1 - w) * J[o0 + 1] + w * J[o1 + 1]) / 100
                    let z = ((1 - w) * J[o0 + 2] + w * J[o1 + 2]) / 100
                    pts[q] = Self.S(x, y, z)
                    fig.joints[q].simdPosition = pts[q]
                }
                for (k, (qa, qb)) in Figure.bonePairs.enumerated() {
                    let d = pts[qb] - pts[qa]
                    let len = max(simd_length(d), 1e-3)
                    let node = fig.bones[k]
                    node.simdPosition = pts[qa] + d / 2
                    node.simdScale = SIMD3(1, len, 1)
                    node.simdOrientation = simd_quatf(from: SIMD3(0, 1, 0), to: d / len)
                }
                fig.bones.forEach { $0.isHidden = false }
                fig.joints.forEach { $0.isHidden = false }
                fig.plain.isHidden = true
                fig.ring.simdPosition = SIMD3(pts[0].x, 0.008, pts[0].z)
                fig.group.isHidden = false
                return
            }
        }

        // No skeleton here: a figure standing at the feet, carried across gaps in
        // the detections up to a second (as the skeletons are), else not drawn.
        let i = floorIndex(p.f, frame) { Double($0) }
        guard i >= 0, p.feet.count >= p.f.count * 2 else { return }
        let j = min(i + 1, p.f.count - 1)
        let bridged = j > i && p.f[j] - p.f[i] <= Self.bridge
        if !bridged && frame - Double(p.f[i]) > 4 { return }
        let w = Float(bridged ? min(max((frame - Double(p.f[i])) / Double(p.f[j] - p.f[i]), 0), 1) : 0)
        let x = ((1 - w) * p.feet[i * 2] + w * p.feet[j * 2]) / 100
        let y = ((1 - w) * p.feet[i * 2 + 1] + w * p.feet[j * 2 + 1]) / 100
        fig.plain.simdPosition = Self.S(x, y, 0.22 + 0.845)
        fig.ring.simdPosition = Self.S(x, y, 0.008)
        fig.bones.forEach { $0.isHidden = true }
        fig.joints.forEach { $0.isHidden = true }
        fig.plain.isHidden = false
        fig.group.isHidden = false
    }

    // MARK: Rallies

    private func loadRally(_ k: Int) {
        for (node, _, _) in rallyNodes { node.removeFromParentNode() }
        rallyNodes = []
        rallyIndex = k
        guard k >= 0, k < matchScene.rallies.count else { return }
        let rally = matchScene.rallies[k]
        for side in ["near", "far"] {
            figures[side]?.setColour(Self.uiColour(rally.who[side].flatMap { $0.isEmpty ? nil : $0 }))
        }
        for (i, s) in rally.shots.enumerated() {
            let n = s.path.count / 3
            guard n >= 2 else { continue }
            let verts = (0..<n).map { q in
                SCNVector3(Self.S(s.path[q * 3] / 100, s.path[q * 3 + 1] / 100, s.path[q * 3 + 2] / 100))
            }
            let arc = SCNNode(geometry: Self.polyline(verts))
            arc.geometry?.firstMaterial = Self.material(Self.uiColour(rally.who[s.hitter]), lit: false)
            arc.opacity = 0.15
            world.rootNode.addChildNode(arc)
            rallyNodes.append((arc, i, .arc))
            if let b = s.bounce, b.count == 3 {
                let tube = SCNTube(innerRadius: 0.13, outerRadius: 0.22, height: 0.002)
                tube.firstMaterial = Self.material(UIColor(CallColor.of(s.landing)), lit: false)
                let ring = SCNNode(geometry: tube)
                ring.simdPosition = Self.S(Float(b[1]), Float(b[2]), 0.012)
                world.rootNode.addChildNode(ring)
                rallyNodes.append((ring, i, .ring))
            }
        }
    }

    private static func polyline(_ verts: [SCNVector3]) -> SCNGeometry {
        let source = SCNGeometrySource(vertices: verts)
        var idx: [Int32] = []
        for i in 0..<max(0, verts.count - 1) { idx += [Int32(i), Int32(i + 1)] }
        let element = SCNGeometryElement(indices: idx, primitiveType: .line)
        return SCNGeometry(sources: [source], elements: [element])
    }

    /// Where a shot's ball is at time t (court metres), or nil outside its flight.
    private static func ballAt(_ s: MatchScene.Shot, _ t: Double, fps: Double) -> SIMD3<Float>? {
        let n = s.path.count / 3
        let k = (t - s.t0) * fps
        guard n > 0, k >= 0, k <= Double(n - 1) else { return nil }
        let i = Int(k), w = Float(k - Double(i)), j = min(i + 1, n - 1)
        let p = s.path
        return SIMD3((1 - w) * p[i * 3] + w * p[j * 3],
                     (1 - w) * p[i * 3 + 1] + w * p[j * 3 + 1],
                     (1 - w) * p[i * 3 + 2] + w * p[j * 3 + 2]) / 100
    }

    // MARK: Camera

    private func presetFor(_ v: Replay3DView) {
        let flip: Float = hitterEnd == "far" ? -1 : 1
        let at: (SIMD3<Float>, SIMD3<Float>)
        switch v {
        case .broadcast: at = (SIMD3(0, -26, 9.5), SIMD3(0, 1, 0))
        // 6.5 m behind where they struck it, a little over eye height, looking
        // at the net: the hitter in the foreground, the shot ahead.
        case .hitter: at = (SIMD3(hitterX * 0.7, hitterY - flip * 6.5, 2.6), SIMD3(hitterX * 0.25, 0, 0.4))
        // In the stadium, from up in the lower stand, over the crowd's heads.
        case .side: at = venue == .stadium ? (SIMD3(24, 0, 15), SIMD3(0, 0, 0)) : (SIMD3(21, 0, 4.5), SIMD3(0, 0, 0.6))
        case .top: at = (SIMD3(0, -0.5, 36), SIMD3(0, 0, 0))
        case .phone, .free: return
        }
        goalPos = Self.S(at.0.x, at.0.y, at.0.z)
        goalTarget = Self.S(at.1.x, at.1.y, at.1.z)
    }

    /// The phone's own view: its rotation, and a projection that maps the picture
    /// as the video under it is letterboxed into the same frame.
    private func applyPhone(_ size: CGSize) {
        let cam = matchScene.camera
        guard cam.rotation.count == 9, cam.position.count == 3, size.width > 0, size.height > 0 else { return }
        let R = cam.rotation.map(Float.init)
        let right = Self.S(R[0], R[1], R[2])
        let up = Self.S(-R[3], -R[4], -R[5]) // image y is down
        let back = Self.S(-R[6], -R[7], -R[8]) // cameras look down -z
        cameraNode.simdPosition = Self.S(Float(cam.position[0]), Float(cam.position[1]), Float(cam.position[2]))
        cameraNode.simdOrientation = simd_quatf(simd_float3x3(columns: (right, up, back)))

        let cw = Double(size.width), ch = Double(size.height)
        let s = min(cw / cam.width, ch / cam.height)
        let ox = (cw - cam.width * s) / 2, oy = (ch - cam.height * s) / 2
        let n = 0.1, far = 300.0
        let u = { (X: Double) in (X - ox) / s }, v = { (Y: Double) in (Y - oy) / s }
        let l = (u(0) - cam.cx) / cam.f * n, r = (u(cw) - cam.cx) / cam.f * n
        let t = (cam.cy - v(0)) / cam.f * n, b = (cam.cy - v(ch)) / cam.f * n
        cameraNode.camera?.projectionTransform = SCNMatrix4(
            m11: Float(2 * n / (r - l)), m12: 0, m13: 0, m14: 0,
            m21: 0, m22: Float(2 * n / (t - b)), m23: 0, m24: 0,
            m31: Float((r + l) / (r - l)), m32: Float((t + b) / (t - b)), m33: Float(-(far + n) / (far - n)), m34: -1,
            m41: 0, m42: 0, m43: Float(-2 * far * n / (far - n)), m44: 0
        )
    }

    private func applyView(_ v: Replay3DView, size: CGSize) {
        let isPhone = v == .phone
        ground.isHidden = isPhone
        let venue = builtVenue?.built
        world.background.contents = isPhone ? UIColor.clear : venue?.background ?? Self.skyColour
        scnView.backgroundColor = isPhone ? .clear : (venue?.background as? UIColor) ?? venue?.fogColour ?? Self.skyColour
        world.fogColor = venue?.fogColour ?? Self.skyColour
        world.fogStartDistance = venue?.fogStart ?? 45
        world.fogEndDistance = isPhone ? 0 : venue?.fogEnd ?? 110
        if isPhone {
            applyPhone(size)
        } else if lastView == .phone || lastView == nil {
            // Back to an ordinary lens.
            let camera = SCNCamera()
            camera.fieldOfView = 45
            camera.zNear = 0.1
            camera.zFar = venue?.zFar ?? 300
            cameraNode.camera = camera
            if lastView == .phone {
                target = cameraNode.simdPosition + cameraNode.simdWorldFront * 12
            }
        }
        lastView = v
    }

    // MARK: Gestures

    /// A drag takes the camera (free orbit) from wherever it is now.
    func orbit(by translation: CGSize) {
        enterFree()
        orbit.yaw -= Float(translation.width) * 0.008
        orbit.pitch = min(max(orbit.pitch + Float(translation.height) * 0.006, 0.03), 1.54)
    }

    func zoom(by scale: CGFloat) {
        enterFree()
        orbit.distance = min(max(orbit.distance / Float(max(scale, 0.01)), 2), 80)
    }

    private func enterFree() {
        guard view != .free else { return }
        if view == .phone { applyView(.free, size: lastSize) }
        let offset = cameraNode.simdPosition - target
        let dist = max(simd_length(offset), 2)
        orbit = (yaw: atan2(offset.x, offset.z), pitch: asin(min(max(offset.y / dist, -1), 1)), distance: dist)
        view = .free
    }

    // MARK: Every frame

    private func tick() {
        let size = scnView.bounds.size
        let t = player.currentTime().seconds
        guard t.isFinite else { return }
        let fps = matchScene.fps
        let frame = t * fps

        // The rally at t (with a little slack either side), else nothing moving.
        let rallies = matchScene.rallies
        let k = floorIndex(rallies, t + 0.5) { $0.start }
        let inRally = k >= 0 && t <= rallies[k].end + 0.5 ? k : -1
        if inRally != rallyIndex { loadRally(inRally) }

        figures.values.forEach { $0.group.isHidden = true }
        ball.isHidden = true; ballShadow.isHidden = true; trailNode.isHidden = true
        var label = rallyIndex >= 0 ? "" : "Between points"
        if rallyIndex >= 0 {
            let rally = rallies[rallyIndex]
            pose("near", frame: frame, rally: rally)
            pose("far", frame: frame, rally: rally)
            // The shot in the air: the latest one started.
            let si = floorIndex(rally.shots, t) { $0.t0 }
            let shot = si >= 0 ? rally.shots[si] : nil
            for entry in rallyNodes {
                switch entry.kind {
                case .arc: entry.node.opacity = entry.shotIndex == si ? 0.5 : 0.12
                case .ring: entry.node.isHidden = (rally.shots[entry.shotIndex].bounce?.first ?? .infinity) > t
                }
            }
            if let shot, shot.path.count >= 3 {
                hitterEnd = shot.hitter
                hitterX = shot.path[0] / 100
                hitterY = shot.path[1] / 100
            }
            if let shot, let p = Self.ballAt(shot, t, fps: fps) {
                ball.isHidden = false; ballShadow.isHidden = false; trailNode.isHidden = false
                ball.simdPosition = Self.S(p.x, p.y, p.z)
                ballShadow.simdPosition = Self.S(p.x, p.y, 0.006)
                ballShadow.simdScale = SIMD3(repeating: 1 + p.z * 0.15)
                ballShadow.opacity = CGFloat(max(0.3, 1 - p.z * 0.2))
                var verts: [SCNVector3] = []
                for d in stride(from: Self.trailFrames, through: 0, by: -1) {
                    if let q = Self.ballAt(shot, t - Double(d) / fps, fps: fps) {
                        verts.append(SCNVector3(Self.S(q.x, q.y, q.z)))
                    }
                }
                if verts.count >= 2 {
                    trailNode.geometry = Self.polyline(verts)
                    trailNode.geometry?.firstMaterial = trailMaterial
                    trailNode.opacity = 0.8
                }
                let who = rally.who[shot.hitter].flatMap { $0.isEmpty ? nil : $0 }
                var parts = ["\(who.map { "Player \($0)" } ?? (shot.hitter == "near" ? "Near player" : "Far player")) · \(Int(shot.speed.rounded())) km/h"]
                if let net = shot.net, net > 0 { parts.append(String(format: "%.2f m over the net", net)) }
                parts.append(String(format: "ball %.1f m up", p.z))
                label = parts.joined(separator: " · ")
            }
        }
        if label != hud { hud = label }

        setVenue(venue)
        if view != lastView || size != lastSize {
            lastSize = size
            applyView(view, size: size)
        }
        switch view {
        case .phone:
            break
        case .free:
            let c = cos(orbit.pitch)
            let offset = SIMD3(sin(orbit.yaw) * c, sin(orbit.pitch), cos(orbit.yaw) * c) * orbit.distance
            cameraNode.simdPosition = target + offset
            aim()
        default:
            presetFor(view)
            easeAround()
            aim()
        }
    }

    /// Point the camera at the target with the sky up.
    ///
    /// SceneKit's plain `look(at:)` keeps whatever "up" the camera already had.
    /// After looking through the (tilted) phone, or when the camera passed over
    /// the point it looks at, that up could end up pointing at the ground — the
    /// whole court turned upside down and stayed that way.
    private func aim() {
        cameraNode.simdLook(at: target, up: SIMD3(0, 1, 0), localFront: SIMD3(0, 0, -1))
    }

    /// Ease towards the preset by swinging round the court, not across it.
    ///
    /// Straight-line easing sent "Behind the hitter" diving over the net to the
    /// other baseline every time the hitter changed ends, passing almost directly
    /// above the target on the way. Easing the camera's angle round the target,
    /// its distance and its height separately pans it round the side of the court
    /// instead, the way a broadcast camera would, and the shortest way round.
    private func easeAround() {
        target += (goalTarget - target) * Self.ease
        let cur = cameraNode.simdPosition - target
        let goal = goalPos - goalTarget
        let curAngle = atan2(cur.x, cur.z), goalAngle = atan2(goal.x, goal.z)
        var turn = goalAngle - curAngle
        if turn > .pi { turn -= 2 * .pi } else if turn < -.pi { turn += 2 * .pi }
        let curRadius = simd_length(SIMD2(cur.x, cur.z)), goalRadius = simd_length(SIMD2(goal.x, goal.z))
        // A preset straight overhead (Top down) has no angle worth turning to.
        let angle = goalRadius < 1 ? curAngle : curAngle + turn * Self.ease
        let radius = curRadius + (goalRadius - curRadius) * Self.ease
        let height = cur.y + (goal.y - cur.y) * Self.ease
        cameraNode.simdPosition = target + SIMD3(sin(angle) * radius, height, cos(angle) * radius)
    }
}

/// CADisplayLink holds its target strongly; this keeps the controller free to go.
private final class DisplayLinkProxy: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}

// MARK: - SwiftUI

/// The 3D scene for the stage: the scene itself, its gestures (drag to orbit,
/// pinch to zoom, tap to play/pause), and the video in a corner — tap that to
/// look through the phone.
struct Replay3DStage: View {
    @ObservedObject var controller: Replay3DController
    let onTogglePlay: () -> Void
    /// Room the stage's own controls take at the bottom, so the corner video
    /// and caption sit clear of them.
    var bottomInset: CGFloat = 0
    var showsCaption = true
    /// Fullscreen keeps its own bar along the top, so the corner video goes to
    /// the bottom there, above the timeline.
    var pipAtBottom = false

    @State private var lastDrag: CGSize = .zero
    @State private var lastPinch: CGFloat = 1

    var body: some View {
        ZStack(alignment: pipAtBottom ? .bottomTrailing : .topTrailing) {
            SceneHost(view: controller.scnView)
                .ignoresSafeArea()
                .gesture(
                    DragGesture(minimumDistance: 4)
                        .onChanged { v in
                            controller.orbit(by: CGSize(width: v.translation.width - lastDrag.width,
                                                        height: v.translation.height - lastDrag.height))
                            lastDrag = v.translation
                        }
                        .onEnded { _ in lastDrag = .zero }
                )
                .simultaneousGesture(
                    MagnifyGesture()
                        .onChanged { v in
                            controller.zoom(by: v.magnification / lastPinch)
                            lastPinch = v.magnification
                        }
                        .onEnded { _ in lastPinch = 1 }
                )
                .onTapGesture(perform: onTogglePlay)

            if controller.view != .phone {
                PlayerLayerView(player: controller.player)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    .frame(width: 104)
                    .background(.black)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.white.opacity(0.5), lineWidth: 1))
                    .shadow(color: .black.opacity(0.4), radius: 6)
                    .padding(8)
                    .padding(.bottom, pipAtBottom ? bottomInset : 0)
                    .onTapGesture { controller.view = .phone }
                    .accessibilityLabel("The video. Tap to look through the phone")
                    .accessibilityAddTraits(.isButton)
            }
        }
        .overlay(alignment: .topLeading) {
            if showsCaption, !controller.hud.isEmpty {
                Replay3DCaption(text: controller.hud).padding(8)
            }
        }
        .onAppear { controller.attach() }
        .onDisappear { controller.detach() }
    }
}

struct Replay3DCaption: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(.black.opacity(0.55), in: Capsule())
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }
}

/// The camera presets as a row of chips.
struct Replay3DViewPicker: View {
    @ObservedObject var controller: Replay3DController
    var onDark = false

    /// Camera angles on one line, the venue on its own line under them.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Replay3DView.presets) { v in
                        chip(v.label, on: controller.view == v) { controller.view = v }
                    }
                    if controller.view == .free {
                        chip("Free · drag to orbit", on: true) {}
                            .allowsHitTesting(false)
                    }
                }
            }
            HStack(spacing: 6) {
                ForEach(Venue.allCases) { v in
                    chip(v.label, on: controller.venue == v) {
                        controller.venue = v
                        // Through the phone you see the real court whatever the venue.
                        if v == .stadium && controller.view == .phone { controller.view = .broadcast }
                    }
                }
            }
        }
    }

    private func chip(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(on ? Theme.accent : (onDark ? Color.black.opacity(0.45) : Theme.surface2), in: Capsule())
                .foregroundStyle(on ? Theme.text : (onDark ? .white : Theme.muted))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The fullscreen player's top bar, with the 3D view on: the camera presets and
/// what the ball is doing.
struct Replay3DFullscreenBar: View {
    @ObservedObject var controller: Replay3DController

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Replay3DViewPicker(controller: controller, onDark: true)
            if !controller.hud.isEmpty {
                Replay3DCaption(text: controller.hud)
            }
            if controller.venue == .stadium {
                Link(stadiumCredit.text, destination: stadiumCredit.url)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.white.opacity(0.8))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.black.opacity(0.5), in: Capsule())
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
    }
}

/// Whatever the 3D view is showing that asks for credit: the poses' model, and
/// the stadium's.
struct Replay3DCredits: View {
    @ObservedObject var controller: Replay3DController

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if controller.matchScene.body == "videopose3d" { PoseCredit() }
            if controller.venue == .stadium {
                Link(stadiumCredit.text, destination: stadiumCredit.url)
                    .font(.caption2)
                    .foregroundStyle(Theme.muted)
            }
        }
    }
}

/// VideoPose3D is CC BY-NC: its output carries the credit and the licence
/// wherever it shows (docs/3D_REPLAY.md §8).
struct PoseCredit: View {
    var body: some View {
        HStack(spacing: 3) {
            Text("Poses:")
            Link("VideoPose3D", destination: URL(string: "https://github.com/facebookresearch/VideoPose3D")!)
            Text("(Meta,")
            Link("CC BY-NC 4.0", destination: URL(string: "https://creativecommons.org/licenses/by-nc/4.0/")!)
            Text(")")
        }
        .font(.caption2)
        .foregroundStyle(Theme.muted)
        .tint(Theme.muted)
    }
}

private struct SceneHost: UIViewRepresentable {
    let view: SCNView
    func makeUIView(context: Context) -> SCNView { view }
    func updateUIView(_ uiView: SCNView, context: Context) {}
}
