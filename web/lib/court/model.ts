/**
 * The tennis court as a 3D model, in metres.
 *
 * Court frame: origin at the centre of the court on the ground; +X across the
 * court, +Y along it away from the camera, +Z up. With the phone behind the near
 * baseline looking down the court, image-right is +X, so "left"/"right" below
 * mean as seen in the video. See docs/3D_REPLAY.md §4.
 */

export type Vec3 = [number, number, number];

const HALF_LENGTH = 11.885; // baseline
const SERVICE = 6.4; // service line, from the net
const DOUBLES = 5.485; // doubles sideline, from the centre
const SINGLES = 4.115; // singles sideline
const POST = 6.4; // net posts (doubles), 0.914 m outside the doubles sideline
const POST_HEIGHT = 1.07;
const NET_CENTRE_HEIGHT = 0.914;
const CENTRE_MARK = 0.1;

export interface Landmark {
  id: string;
  label: string;
  group: "Corners" | "Service lines" | "Centre marks" | "Net";
  pos: Vec3;
  /** Sits where two painted lines cross, so the snap can refine it. */
  snaps: boolean;
}

const ground = (
  id: string,
  label: string,
  group: Landmark["group"],
  x: number,
  y: number,
): Landmark => ({ id, label, group, pos: [x, y, 0], snaps: true });

export const LANDMARKS: Landmark[] = [
  ground("far_left_doubles", "Far left — doubles corner", "Corners", -DOUBLES, HALF_LENGTH),
  ground("far_right_doubles", "Far right — doubles corner", "Corners", DOUBLES, HALF_LENGTH),
  ground("near_right_doubles", "Near right — doubles corner", "Corners", DOUBLES, -HALF_LENGTH),
  ground("near_left_doubles", "Near left — doubles corner", "Corners", -DOUBLES, -HALF_LENGTH),
  ground("far_left_singles", "Far left — singles corner", "Corners", -SINGLES, HALF_LENGTH),
  ground("far_right_singles", "Far right — singles corner", "Corners", SINGLES, HALF_LENGTH),
  ground("near_right_singles", "Near right — singles corner", "Corners", SINGLES, -HALF_LENGTH),
  ground("near_left_singles", "Near left — singles corner", "Corners", -SINGLES, -HALF_LENGTH),

  ground("far_t", "Far T (service line × centre line)", "Service lines", 0, SERVICE),
  ground("near_t", "Near T (service line × centre line)", "Service lines", 0, -SERVICE),
  ground("far_left_service", "Far service line × left singles line", "Service lines", -SINGLES, SERVICE),
  ground("far_right_service", "Far service line × right singles line", "Service lines", SINGLES, SERVICE),
  ground("near_left_service", "Near service line × left singles line", "Service lines", -SINGLES, -SERVICE),
  ground("near_right_service", "Near service line × right singles line", "Service lines", SINGLES, -SERVICE),

  ground("far_centre_mark", "Far baseline centre mark", "Centre marks", 0, HALF_LENGTH),
  ground("near_centre_mark", "Near baseline centre mark", "Centre marks", 0, -HALF_LENGTH),

  { id: "left_post_top", label: "Left net post — top", group: "Net", pos: [-POST, 0, POST_HEIGHT], snaps: false },
  { id: "right_post_top", label: "Right net post — top", group: "Net", pos: [POST, 0, POST_HEIGHT], snaps: false },
  { id: "left_post_base", label: "Left net post — base", group: "Net", pos: [-POST, 0, 0], snaps: false },
  { id: "right_post_base", label: "Right net post — base", group: "Net", pos: [POST, 0, 0], snaps: false },
  { id: "net_centre_top", label: "Net centre — top of strap", group: "Net", pos: [0, 0, NET_CENTRE_HEIGHT], snaps: false },
];

export const LANDMARK_BY_ID: ReadonlyMap<string, Landmark> = new Map(
  LANDMARKS.map((l) => [l.id, l]),
);

/** The four the panel walks you through first — they frame the whole court. */
/**
 * Quick mode: three points anyone can find at a glance, near the camera where
 * the paint is biggest. The solver fills in the lens; the analysis snaps the
 * rest onto the painted lines (lib/court/solve.ts, QUICK_FOCAL).
 */
export const QUICK_SEQUENCE = ["near_left_singles", "near_right_singles", "near_t"];

export const DEFAULT_SEQUENCE = [
  "far_left_doubles",
  "far_right_doubles",
  "near_right_doubles",
  "near_left_doubles",
];

/** Painted lines and the net, drawn back over the frame to check a calibration. */
export interface CourtSegment {
  a: Vec3;
  b: Vec3;
  kind: "line" | "net";
}

const seg = (a: Vec3, b: Vec3, kind: CourtSegment["kind"] = "line"): CourtSegment => ({ a, b, kind });

export const COURT_SEGMENTS: CourtSegment[] = [
  // Baselines and sidelines.
  seg([-DOUBLES, HALF_LENGTH, 0], [DOUBLES, HALF_LENGTH, 0]),
  seg([-DOUBLES, -HALF_LENGTH, 0], [DOUBLES, -HALF_LENGTH, 0]),
  seg([-DOUBLES, -HALF_LENGTH, 0], [-DOUBLES, HALF_LENGTH, 0]),
  seg([DOUBLES, -HALF_LENGTH, 0], [DOUBLES, HALF_LENGTH, 0]),
  seg([-SINGLES, -HALF_LENGTH, 0], [-SINGLES, HALF_LENGTH, 0]),
  seg([SINGLES, -HALF_LENGTH, 0], [SINGLES, HALF_LENGTH, 0]),
  // Service lines, centre service line, centre marks.
  seg([-SINGLES, SERVICE, 0], [SINGLES, SERVICE, 0]),
  seg([-SINGLES, -SERVICE, 0], [SINGLES, -SERVICE, 0]),
  seg([0, -SERVICE, 0], [0, SERVICE, 0]),
  seg([0, HALF_LENGTH, 0], [0, HALF_LENGTH - CENTRE_MARK, 0]),
  seg([0, -HALF_LENGTH, 0], [0, -HALF_LENGTH + CENTRE_MARK, 0]),
  // Net: posts and the top of the net, which sags to the centre strap.
  seg([-POST, 0, 0], [-POST, 0, POST_HEIGHT], "net"),
  seg([POST, 0, 0], [POST, 0, POST_HEIGHT], "net"),
  seg([-POST, 0, POST_HEIGHT], [0, 0, NET_CENTRE_HEIGHT], "net"),
  seg([0, 0, NET_CENTRE_HEIGHT], [POST, 0, POST_HEIGHT], "net"),
];
