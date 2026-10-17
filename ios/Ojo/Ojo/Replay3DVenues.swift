import SceneKit
import SwiftUI
import UIKit
import simd

/// Where the 3D view's match is played: everything round the players, ball,
/// lines and net (Replay3D draws those the same in every venue). The native
/// form of web/app/Replay3DVenues.ts.
///
/// - "Your court": the court it was recorded on. Its surface from the video, and
///   its surroundings — fences, trees, buildings, sky — painted from the video
///   onto walls at the fences.
/// - "Stadium": a covered show court (Estadio Parque Roca, from a CC-BY model;
///   credit in `stadiumCredit`), its clay swapped for the recorded court's own
///   surface and its walls carrying our boards.
///
/// Court coordinates (metres: x across, y away from the phone, z up) map to
/// SceneKit as (x, z, -y), as in Replay3D.
enum Venue: String, CaseIterable, Identifiable {
    case court, stadium

    var id: String { rawValue }

    var label: String {
        switch self {
        case .court: return "Your court"
        case .stadium: return "Stadium"
        }
    }
}

/// A venue, ready to hang under the scene's ground.
struct BuiltVenue {
    let node: SCNNode
    /// A colour, or an image the scene wraps round itself as a sky.
    let background: Any
    let fogColour: UIColor
    let fogStart: CGFloat
    let fogEnd: CGFloat
    /// How far the camera has to see: a stadium is a couple of hundred metres across.
    let zFar: Double
}

/// CC BY 4.0 asks for this wherever the model is shown.
let stadiumCredit = (
    text: "Stadium: “Estadio Parque Roca” by A1905, CC BY 4.0",
    url: URL(string: "https://sketchfab.com/3d-models/estadio-parque-roca-35eff25bb57f4cf1b8209e6fd2abc164")!
)

@MainActor
enum VenueBuilder {
    private static func S(_ x: Float, _ y: Float, _ z: Float) -> SIMD3<Float> { SIMD3(x, z, -y) }
    private static let d: Float = 5.485, hl: Float = 11.885

    private static func lambert(_ contents: Any) -> SCNMaterial {
        let m = SCNMaterial()
        m.diffuse.contents = contents
        m.lightingModel = .lambert
        return m
    }

    private static func flat(_ width: Float, _ length: Float, _ material: SCNMaterial, height: Float) -> SCNNode {
        let plane = SCNPlane(width: CGFloat(width), height: CGFloat(length))
        plane.firstMaterial = material
        let node = SCNNode(geometry: plane)
        node.eulerAngles.x = -.pi / 2
        node.simdPosition.y = height
        return node
    }

    static func image(fromDataURL s: String) -> UIImage? {
        guard let comma = s.firstIndex(of: ",") else { return nil }
        guard let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }

    private static func cornerColour(_ image: UIImage) -> UIColor? {
        guard let cg = image.cgImage?.cropping(to: CGRect(x: 1, y: 1, width: 1, height: 1)) else { return nil }
        var px = [UInt8](repeating: 0, count: 4)
        guard let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return UIColor(red: CGFloat(px[0]) / 255, green: CGFloat(px[1]) / 255, blue: CGFloat(px[2]) / 255, alpha: 1)
    }

    /// The recorded court's surface from the video, on a run-off of `runW` ×
    /// `runL` metres that takes the texture's own edge colour.
    private static func videoSurface(_ scene: MatchScene, into group: SCNNode, runW: Float, runL: Float) {
        let surround = lambert(UIColor(red: 0x8A / 255, green: 0x4A / 255, blue: 0x30 / 255, alpha: 1))
        group.addChildNode(flat(runW, runL, surround, height: -0.02))
        if let court = scene.court, let image = image(fromDataURL: court.texture) {
            let m = lambert(image)
            m.diffuse.mipFilter = .linear
            m.diffuse.maxAnisotropy = 8
            group.addChildNode(flat(Float(2 * court.halfWidth), Float(2 * court.halfLength), m, height: -0.01))
            if let edge = cornerColour(image) { surround.diffuse.contents = edge }
        } else {
            let clay = lambert(UIColor(red: 0xA3 / 255, green: 0x5A / 255, blue: 0x3A / 255, alpha: 1))
            group.addChildNode(flat(2 * (d + 3.5), 2 * (hl + 6.4), clay, height: -0.01))
        }
    }

    // MARK: - Your court

    static func recordedCourt(_ scene: MatchScene) -> BuiltVenue {
        let group = SCNNode()
        videoSurface(scene, into: group, runW: 400, runL: 400) // to the horizon, where the fog takes it
        group.addChildNode(phone(scene))

        let su = scene.surroundings
        let sky = su.map { UIColor(red: $0.sky[0] / 255, green: $0.sky[1] / 255, blue: $0.sky[2] / 255, alpha: 1) }
            ?? UIColor(Theme.bg)

        if let su, let plate = image(fromDataURL: su.plate)?.cgImage {
            // Shown once painted: until then they'd be blank.
            let walls = SCNNode()
            walls.isHidden = true
            group.addChildNode(walls)
            let hw = Float(su.halfWidth), hl = Float(su.halfLength), height: Float = 30
            for side in WallPainter.Side.allCases {
                let across = side == .far || side == .near
                let plane = SCNPlane(width: CGFloat(across ? 2 * hw : 2 * hl), height: CGFloat(height))
                let m = SCNMaterial()
                m.lightingModel = .constant
                m.diffuse.contents = sky
                m.diffuse.mipFilter = .linear
                plane.firstMaterial = m
                let node = SCNNode(geometry: plane)
                switch side {
                case .far: node.simdPosition = S(0, hl, height / 2)
                case .near: node.simdPosition = S(0, -hl, height / 2); node.eulerAngles.y = .pi
                case .left: node.simdPosition = S(-hw, 0, height / 2); node.eulerAngles.y = .pi / 2
                case .right: node.simdPosition = S(hw, 0, height / 2); node.eulerAngles.y = -.pi / 2
                }
                walls.addChildNode(node)
            }
            // A second or so of arithmetic per wall: off the main thread.
            let camera = scene.camera
            Task.detached(priority: .userInitiated) {
                let painter = WallPainter(camera: camera, plate: plate, sky: sky)
                let images = WallPainter.Side.allCases.map { painter.paint($0, halfWidth: hw, halfLength: hl, height: height) }
                await MainActor.run {
                    for (node, image) in zip(walls.childNodes, images) {
                        node.geometry?.firstMaterial?.diffuse.contents = image
                    }
                    walls.isHidden = false
                }
            }
        }

        return BuiltVenue(node: group, background: su != nil ? sky : UIColor(Theme.bg), fogColour: sky,
                          fogStart: su != nil ? 60 : 45, fogEnd: su != nil ? 160 : 110, zFar: 300)
    }

    /// The phone, where the calibration put it, on its pole.
    private static func phone(_ scene: MatchScene) -> SCNNode {
        let phone = SCNNode()
        let cam = scene.camera
        guard cam.position.count == 3, cam.rotation.count == 9 else { return phone }
        let p = cam.position.map(Float.init), R = cam.rotation.map(Float.init)
        let body = SCNNode(geometry: SCNBox(width: 0.16, height: 0.08, length: 0.012, chamferRadius: 0.006))
        body.geometry?.firstMaterial = lambert(UIColor(Theme.accent))
        phone.addChildNode(body)
        let pole = SCNNode(geometry: SCNCylinder(radius: 0.015, height: CGFloat(p[2])))
        pole.geometry?.firstMaterial = lambert(UIColor(red: 0.42, green: 0.38, blue: 0.35, alpha: 1))
        pole.simdPosition.y = -p[2] / 2
        phone.addChildNode(pole)
        phone.simdPosition = S(p[0], p[1], p[2])
        body.simdLook(at: phone.simdPosition + S(R[6], R[7], R[8]), up: SIMD3(0, 1, 0), localFront: SIMD3(0, 0, 1))
        return phone
    }

    // MARK: - Stadium

    /// Where the model's court is, in the model's own frame (metres, y up), and
    /// what to leave out: its clay (the recorded court goes there) and its net
    /// (Replay3D draws the net every venue shares). As on the web.
    private static let modelCentre = SIMD3<Float>(200.53, 0.91, -40.71)
    private static let hidden: Set<String> = ["material_22", "Fencing", "Color_H0", "Color_I0", "69_iron"]
    /// The inner faces of its green walls round the court, in our court metres.
    private enum Wall {
        static let left: Float = -12.23, right: Float = 12.49, sideLen: Float = 22.8
        static let near: Float = -25.4, far: Float = 25.58, endLen: Float = 8.4
    }

    static func stadium(_ scene: MatchScene) -> BuiltVenue {
        let group = SCNNode()
        // The recorded surface out to the walls, shown straight away; the
        // stadium round it arrives once it has loaded.
        videoSurface(scene, into: group, runW: Wall.right - Wall.left, runL: Wall.far - Wall.near)
        group.addChildNode(flat(400, 400, lambert(UIColor(red: 0x6F / 255, green: 0x6A / 255, blue: 0x62 / 255, alpha: 1)), height: -0.05))

        // Our boards along the foot of the green walls, just in front of them.
        let boardH: Float = 1.1, inset: Float = 0.04, y = boardH / 2 + 0.02
        let boards: [(SIMD3<Float>, Float, Float)] = [
            (S(Wall.left + inset, 0, y), .pi / 2, 2 * Wall.sideLen),
            (S(Wall.right - inset, 0, y), -.pi / 2, 2 * Wall.sideLen),
            (S(0, Wall.far - inset, y), 0, 2 * Wall.endLen),
            (S(0, Wall.near + inset, y), .pi, 2 * Wall.endLen),
        ]
        let board = boardImage(height: boardH)
        for (at, turn, len) in boards {
            let plane = SCNPlane(width: CGFloat(len), height: CGFloat(boardH))
            let m = lambert(board)
            m.diffuse.wrapS = .repeat
            m.diffuse.contentsTransform = SCNMatrix4MakeScale(len / boardUnit, 1, 1)
            plane.firstMaterial = m
            let node = SCNNode(geometry: plane)
            node.simdPosition = at
            node.eulerAngles.y = turn
            group.addChildNode(node)
        }

        // The model is a few MB of geometry: read it off the main thread.
        let holder = SCNNode()
        holder.eulerAngles.y = .pi / 2 // its long axis (+x) to ours (+y)
        group.addChildNode(holder)
        if let url = Bundle.main.url(forResource: "parque-roca.plain", withExtension: "glb")
            ?? Bundle.main.url(forResource: "parque-roca.plain", withExtension: "glb", subdirectory: "Venues") {
            let hide = hidden, centre = modelCentre
            Task.detached(priority: .userInitiated) {
                do {
                    let model = try PlainGLB.load(url, hiding: hide)
                    model.simdPosition = -centre
                    await MainActor.run { holder.addChildNode(model) }
                } catch {
                    print("[venue] the stadium couldn't load; showing the court on its own: \(error)")
                }
            }
        }

        return BuiltVenue(node: group, background: skyImage(), fogColour: UIColor(red: 0xDF / 255, green: 0xE9 / 255, blue: 0xF1 / 255, alpha: 1),
                          fogStart: 160, fogEnd: 420, zFar: 700)
    }

    /// Metres of board per repeat of its artwork.
    private static let boardUnit: Float = 9

    /// Our board: dark green, the Ojo mark and name in cream and clay, repeating.
    private static func boardImage(height: Float) -> UIImage {
        let px: CGFloat = 96 // per metre
        let size = CGSize(width: CGFloat(boardUnit) * px, height: CGFloat(height) * px)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor(red: 0x0D / 255, green: 0x3B / 255, blue: 0x2A / 255, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            UIColor(Theme.accent).setFill()
            ctx.fill(CGRect(x: 0, y: size.height - 6, width: size.width, height: 6))
            let s = size.height * 0.62, y = (size.height - s) / 2 - 3
            let logo = UIImage(named: "OjoLogo")
            let font = UIFont.systemFont(ofSize: size.height * 0.5, weight: .heavy)
            let cream = UIColor(red: 0xF4 / 255, green: 0xF1 / 255, blue: 0xE8 / 255, alpha: 1)
            for (x0, word) in [(0.06, "OJO"), (0.46, "OJO TENNIS")] {
                let x = CGFloat(x0) * size.width
                if let logo {
                    let rect = CGRect(x: x, y: y, width: s, height: s)
                    UIBezierPath(roundedRect: rect, cornerRadius: s * 0.22).addClip()
                    logo.draw(in: rect)
                    ctx.cgContext.resetClip()
                }
                let text = NSAttributedString(string: word, attributes: [.font: font, .foregroundColor: cream])
                let h = text.size().height
                text.draw(at: CGPoint(x: x + s + size.height * 0.22, y: (size.height - h) / 2 - 2))
            }
        }
    }

    /// A clear afternoon over the open roof, wrapped round the scene.
    private static func skyImage() -> UIImage {
        let size = CGSize(width: 4, height: 256)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let colours = [UIColor(red: 0x4F / 255, green: 0x8F / 255, blue: 0xD0 / 255, alpha: 1),
                           UIColor(red: 0x9C / 255, green: 0xC3 / 255, blue: 0xE6 / 255, alpha: 1),
                           UIColor(red: 0xE4 / 255, green: 0xED / 255, blue: 0xF3 / 255, alpha: 1)].map(\.cgColor)
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colours as CFArray, locations: [0, 0.3, 0.5])!
            ctx.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [.drawsAfterEndLocation])
        }
    }
}

// MARK: - Walls painted from the video

/// Paints the walls round the recorded court with what the phone saw in that
/// direction: each point of a wall is projected through the calibrated camera
/// into the clean plate. Wall the phone never saw (behind it, beside it) takes
/// the same point mirrored across the net, which it did see — as the far half
/// of the court's surface does. Above everything it saw, the sky.
///
/// Where both a point and its mirrored twin were seen, the sharper wins: the
/// one the phone saw more squarely and closer (pixels per square metre go as
/// cos(angle) / distance²), and what was seen poorly is softened to read as
/// out-of-focus background rather than streaks.
///
/// The web does this per pixel in a shader every frame; the walls never move,
/// so here it's done once, into an ordinary texture per wall.
nonisolated private struct WallPainter: Sendable {
    enum Side: CaseIterable { case far, near, left, right }

    /// The plate, and successively halved copies of it for the soft parts.
    private let levels: [(w: Int, h: Int, px: [UInt8])]
    private let R: simd_float3x3
    private let T: SIMD3<Float>
    private let eye: SIMD3<Float>
    private let f: Float, cx: Float, cy: Float, width: Float, height: Float
    private let sky: SIMD3<Float>

    /// Pixels painted per metre of wall.
    private static let density: Float = 16
    /// How well the far wall's top was seen from the phone (face-on, ~42 m):
    /// anything worse than this is softened.
    private static let wellSeen: Float = 1 / 1800

    init(camera c: MatchScene.Camera, plate: CGImage, sky: UIColor) {
        let r = c.rotation.map(Float.init)
        // Rows of the court → camera rotation.
        R = simd_float3x3(rows: [SIMD3(r[0], r[1], r[2]), SIMD3(r[3], r[4], r[5]), SIMD3(r[6], r[7], r[8])])
        eye = SIMD3(Float(c.position[0]), Float(c.position[1]), Float(c.position[2]))
        T = -(R * eye)
        f = Float(c.f); cx = Float(c.cx); cy = Float(c.cy); width = Float(c.width); height = Float(c.height)
        var (r0, g0, b0, a0): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 1)
        sky.getRed(&r0, green: &g0, blue: &b0, alpha: &a0)
        self.sky = SIMD3(Float(r0), Float(g0), Float(b0)) * 255

        var levels: [(Int, Int, [UInt8])] = []
        var w = plate.width, h = plate.height
        var px = Self.pixels(plate)
        levels.append((w, h, px))
        for _ in 0..<5 {
            let (nw, nh) = (max(1, w / 2), max(1, h / 2))
            var next = [UInt8](repeating: 0, count: nw * nh * 4)
            for y in 0..<nh {
                for x in 0..<nw {
                    let x0 = min(2 * x, w - 1), x1 = min(2 * x + 1, w - 1)
                    let y0 = min(2 * y, h - 1), y1 = min(2 * y + 1, h - 1)
                    for c in 0..<3 {
                        let s = Int(px[(y0 * w + x0) * 4 + c]) + Int(px[(y0 * w + x1) * 4 + c])
                            + Int(px[(y1 * w + x0) * 4 + c]) + Int(px[(y1 * w + x1) * 4 + c])
                        next[(y * nw + x) * 4 + c] = UInt8(s / 4)
                    }
                }
            }
            (w, h, px) = (nw, nh, next)
            levels.append((w, h, px))
        }
        self.levels = levels.map { (w: $0.0, h: $0.1, px: $0.2) }
    }

    private static func pixels(_ image: CGImage) -> [UInt8] {
        var px = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let ctx = CGContext(data: &px, width: image.width, height: image.height, bitsPerComponent: 8,
                            bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        ctx?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return px
    }

    /// Where a court point lands in the plate, as a fraction of its size.
    private func look(_ p: SIMD3<Float>) -> SIMD2<Float>? {
        let c = R * p + T
        guard c.z >= 0.5 else { return nil }
        let u = (f * c.x / c.z + cx) / width, v = (f * c.y / c.z + cy) / height
        guard u > 0.002, u < 0.998, v > 0.002, v < 0.998 else { return nil }
        return SIMD2(u, v)
    }

    private func sharpness(_ p: SIMD3<Float>, _ n: SIMD3<Float>) -> Float {
        let r = p - eye
        let d2 = simd_dot(r, r)
        return abs(simd_dot(simd_normalize(r), n)) / d2
    }

    private func sample(_ uv: SIMD2<Float>, level: Int) -> SIMD3<Float> {
        let l = levels[min(level, levels.count - 1)]
        let x = uv.x * Float(l.w) - 0.5, y = uv.y * Float(l.h) - 0.5
        let x0 = max(0, min(l.w - 1, Int(x.rounded(.down)))), y0 = max(0, min(l.h - 1, Int(y.rounded(.down))))
        let x1 = min(l.w - 1, x0 + 1), y1 = min(l.h - 1, y0 + 1)
        let fx = max(0, min(1, x - Float(x0))), fy = max(0, min(1, y - Float(y0)))
        func at(_ xi: Int, _ yi: Int) -> SIMD3<Float> {
            let o = (yi * l.w + xi) * 4
            return SIMD3(Float(l.px[o]), Float(l.px[o + 1]), Float(l.px[o + 2]))
        }
        let top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx
        let bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx
        return top * (1 - fy) + bottom * fy
    }

    private func colour(_ uv: SIMD2<Float>, seen how: Float) -> SIMD3<Float> {
        let lod = min(5, max(0, log2(Self.wellSeen / how)))
        let lo = Int(lod), w = lod - Float(lo)
        let a = sample(uv, level: lo)
        return w < 0.01 ? a : a * (1 - w) + sample(uv, level: lo + 1) * w
    }

    func paint(_ side: Side, halfWidth hw: Float, halfLength hl: Float, height: Float) -> UIImage {
        let across = side == .far || side == .near
        let span = across ? 2 * hw : 2 * hl
        let W = Int(span * Self.density), H = Int(height * Self.density)
        var out = [UInt8](repeating: 255, count: W * H * 4)
        let normal: SIMD3<Float>
        switch side {
        case .far: normal = SIMD3(0, -1, 0)
        case .near: normal = SIMD3(0, 1, 0)
        case .left: normal = SIMD3(1, 0, 0)
        case .right: normal = SIMD3(-1, 0, 0)
        }
        let twinNormal = SIMD3(normal.x, -normal.y, normal.z)
        for row in 0..<H {
            let z = height - (Float(row) + 0.5) / Float(H) * height
            for col in 0..<W {
                // The texture's left edge, seen from inside the court.
                let s = (Float(col) + 0.5) / Float(W) * span
                let p: SIMD3<Float>
                switch side {
                case .far: p = SIMD3(-hw + s, hl, z)
                case .near: p = SIMD3(hw - s, -hl, z)
                case .left: p = SIMD3(-hw, -hl + s, z)
                case .right: p = SIMD3(hw, hl - s, z)
                }
                let twin = SIMD3(p.x, -p.y, p.z)
                let uv = look(p), uvTwin = look(twin)
                let how = sharpness(p, normal), howTwin = sharpness(twin, twinNormal)
                var c = sky
                if let uv, uvTwin == nil || how >= howTwin {
                    c = colour(uv, seen: how)
                } else if let uvTwin {
                    c = colour(uvTwin, seen: howTwin)
                }
                let o = (row * W + col) * 4
                out[o] = UInt8(max(0, min(255, c.x)))
                out[o + 1] = UInt8(max(0, min(255, c.y)))
                out[o + 2] = UInt8(max(0, min(255, c.z)))
            }
        }
        let provider = CGDataProvider(data: Data(out) as CFData)!
        let cg = CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W * 4,
                         space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                         provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
        return UIImage(cgImage: cg)
    }
}

// MARK: - A plain glTF model

/// Reads the stadium as `web/scripts/venue-to-plain.mjs` writes it: float
/// positions, normals and texture coordinates, 32-bit indices, every mesh
/// already in the model's frame, and materials with a colour and/or a JPEG or
/// PNG. Deliberately no more of glTF than that.
nonisolated enum PlainGLB {
    enum Failure: Error { case notGLB, missing(String) }

    static func load(_ url: URL, hiding: Set<String>) throws -> SCNNode {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        guard data.count > 20, data.prefix(4) == Data("glTF".utf8) else { throw Failure.notGLB }
        func u32(_ at: Int) -> Int { Int(data.subdata(in: at..<at + 4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }) }
        let jsonLen = u32(12)
        guard let json = try JSONSerialization.jsonObject(with: data.subdata(in: 20..<20 + jsonLen)) as? [String: Any] else {
            throw Failure.missing("json")
        }
        let binStart = 20 + jsonLen + 8
        let bin = data.subdata(in: binStart..<binStart + u32(20 + jsonLen))

        let views = json["bufferViews"] as? [[String: Any]] ?? []
        let accessors = json["accessors"] as? [[String: Any]] ?? []
        func viewData(_ i: Int) -> Data {
            let v = views[i]
            let off = v["byteOffset"] as? Int ?? 0
            return bin.subdata(in: off..<off + (v["byteLength"] as? Int ?? 0))
        }
        func accessor(_ i: Int) -> (data: Data, count: Int) {
            let a = accessors[i]
            let d = viewData(a["bufferView"] as? Int ?? 0)
            let off = a["byteOffset"] as? Int ?? 0
            return (off == 0 ? d : d.subdata(in: off..<d.count), a["count"] as? Int ?? 0)
        }

        let images: [UIImage?] = (json["images"] as? [[String: Any]] ?? []).map { img in
            (img["bufferView"] as? Int).flatMap { UIImage(data: viewData($0)) }
        }
        let textures = json["textures"] as? [[String: Any]] ?? []
        func texture(_ ref: Any?) -> UIImage? {
            guard let index = (ref as? [String: Any])?["index"] as? Int, index < textures.count,
                  let source = textures[index]["source"] as? Int, source < images.count else { return nil }
            return images[source]
        }
        /// glTF colours are linear; UIKit's are sRGB.
        func colour(_ c: [Double]) -> UIColor {
            let s = c.prefix(3).map { CGFloat(pow(max($0, 0), 1 / 2.2)) }
            return UIColor(red: s[0], green: s[1], blue: s[2], alpha: CGFloat(c.count > 3 ? c[3] : 1))
        }

        let materialDefs = json["materials"] as? [[String: Any]] ?? []
        let materials: [(name: String, material: SCNMaterial)] = materialDefs.map { def in
            let m = SCNMaterial()
            let name = def["name"] as? String ?? ""
            m.name = name
            m.lightingModel = .lambert
            m.isDoubleSided = def["doubleSided"] as? Bool ?? false
            let pbr = def["pbrMetallicRoughness"] as? [String: Any] ?? [:]
            let factor = (pbr["baseColorFactor"] as? [Double]) ?? [1, 1, 1, 1]
            if let image = texture(pbr["baseColorTexture"]) {
                m.diffuse.contents = image
                if factor.prefix(3).contains(where: { $0 < 0.999 }) { m.multiply.contents = colour(factor) }
            } else {
                m.diffuse.contents = colour(Array(factor.prefix(3)) + [1])
            }
            for prop in [m.diffuse, m.multiply] {
                prop.wrapS = .repeat
                prop.wrapT = .repeat
                prop.mipFilter = .linear
            }
            if let emissive = texture(def["emissiveTexture"]) { m.emission.contents = emissive }
            if def["alphaMode"] as? String == "BLEND" {
                m.blendMode = .alpha
                m.transparencyMode = .aOne
                if factor.count > 3, factor[3] < 1 { m.transparency = CGFloat(factor[3]) }
                m.writesToDepthBuffer = false
            }
            return (name, m)
        }

        let root = SCNNode()
        for meshDef in json["meshes"] as? [[String: Any]] ?? [] {
            for prim in meshDef["primitives"] as? [[String: Any]] ?? [] {
                let matIndex = prim["material"] as? Int
                if let matIndex, hiding.contains(materials[matIndex].name) { continue }
                guard let attrs = prim["attributes"] as? [String: Int], let posIndex = attrs["POSITION"],
                      let idxIndex = prim["indices"] as? Int else { continue }
                let pos = accessor(posIndex)
                var sources = [SCNGeometrySource(data: pos.data, semantic: .vertex, vectorCount: pos.count,
                                                 usesFloatComponents: true, componentsPerVector: 3,
                                                 bytesPerComponent: 4, dataOffset: 0, dataStride: 12)]
                if let n = attrs["NORMAL"] {
                    let a = accessor(n)
                    sources.append(SCNGeometrySource(data: a.data, semantic: .normal, vectorCount: a.count,
                                                     usesFloatComponents: true, componentsPerVector: 3,
                                                     bytesPerComponent: 4, dataOffset: 0, dataStride: 12))
                }
                if let t = attrs["TEXCOORD_0"] {
                    let a = accessor(t)
                    sources.append(SCNGeometrySource(data: a.data, semantic: .texcoord, vectorCount: a.count,
                                                     usesFloatComponents: true, componentsPerVector: 2,
                                                     bytesPerComponent: 4, dataOffset: 0, dataStride: 8))
                }
                let idx = accessor(idxIndex)
                let element = SCNGeometryElement(data: idx.data, primitiveType: .triangles,
                                                 primitiveCount: idx.count / 3, bytesPerIndex: 4)
                let geometry = SCNGeometry(sources: sources, elements: [element])
                if let matIndex { geometry.materials = [materials[matIndex].material] }
                let node = SCNNode(geometry: geometry)
                node.castsShadow = false
                root.addChildNode(node)
            }
        }
        return root
    }
}
