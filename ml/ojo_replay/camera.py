"""The calibrated camera, in court coordinates.

Mirrors web/lib/court/solve.ts: pinhole, square pixels, rotation and translation
taking court points (metres; origin at centre court on the ground, +X across to
image-right, +Y away from the camera, +Z up) into camera coordinates (x right,
y down, z forward). The calibration is the one saved from the web panel.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Court lines, for drawing (metres).
HALF_LENGTH, SERVICE, DOUBLES, SINGLES = 11.885, 6.40, 5.485, 4.115
POST, POST_HEIGHT, NET_CENTRE = 6.40, 1.07, 0.914
COURT_LINES = [
    ((-DOUBLES, HALF_LENGTH), (DOUBLES, HALF_LENGTH)),
    ((-DOUBLES, -HALF_LENGTH), (DOUBLES, -HALF_LENGTH)),
    ((-DOUBLES, -HALF_LENGTH), (-DOUBLES, HALF_LENGTH)),
    ((DOUBLES, -HALF_LENGTH), (DOUBLES, HALF_LENGTH)),
    ((-SINGLES, -HALF_LENGTH), (-SINGLES, HALF_LENGTH)),
    ((SINGLES, -HALF_LENGTH), (SINGLES, HALF_LENGTH)),
    ((-SINGLES, SERVICE), (SINGLES, SERVICE)),
    ((-SINGLES, -SERVICE), (SINGLES, -SERVICE)),
    ((0, -SERVICE), (0, SERVICE)),
]


@dataclass
class Camera:
    K: np.ndarray  # 3x3
    R: np.ndarray  # 3x3, court -> camera
    t: np.ndarray  # 3, court -> camera
    width: int
    height: int

    @classmethod
    def from_match(cls, match_json: Path) -> "Camera":
        return cls.from_calibration(json.loads(Path(match_json).read_text())["calibration"])

    @classmethod
    def from_calibration(cls, cal: dict) -> "Camera":
        """From a saved calibration (the web panel's, or autocal's)."""
        cam = cal["camera"]
        K = np.array([[cam["f"], 0, cam["cx"]], [0, cam["f"], cam["cy"]], [0, 0, 1.0]])
        return cls(
            K=K,
            R=np.array(cam["rotation"], dtype=float).reshape(3, 3),
            t=np.array(cam["translation"], dtype=float),
            width=cal["imageWidth"],
            height=cal["imageHeight"],
        )

    @property
    def position(self) -> np.ndarray:
        """Camera centre in court coordinates."""
        return -self.R.T @ self.t

    def project(self, pts: np.ndarray) -> np.ndarray:
        """Court points (N, 3) -> pixels (N, 2). Points behind the camera give NaN."""
        pts = np.atleast_2d(pts)
        cam = pts @ self.R.T + self.t
        z = cam[:, 2:3]
        uv = (cam[:, :2] / np.where(z > 1e-6, z, np.nan)) * self.K[0, 0] + self.K[:2, 2]
        return uv

    def ray(self, uv: np.ndarray) -> np.ndarray:
        """Pixels (N, 2) -> unit ray directions (N, 3) in court coordinates."""
        uv = np.atleast_2d(uv)
        d_cam = np.column_stack([(uv - self.K[:2, 2]) / self.K[0, 0], np.ones(len(uv))])
        d = d_cam @ self.R  # R.T @ d_cam per row
        return d / np.linalg.norm(d, axis=1, keepdims=True)

    def to_ground(self, uv: np.ndarray, height: float = 0.0) -> np.ndarray:
        """Pixels (N, 2) -> where their rays meet the plane z = height (N, 3)."""
        d = self.ray(uv)
        c = self.position
        s = (height - c[2]) / d[:, 2]
        return c + s[:, None] * d
