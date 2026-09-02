"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExitFullscreenIcon,
  FullscreenIcon,
  MuteIcon,
  NextFrameIcon,
  NextRallyIcon,
  PauseIcon,
  PlayIcon,
  PrevFrameIcon,
  VolumeIcon,
} from "./icons";

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

/** m:ss — the same clock the rally timeline prints, so the two agree on sight. */
function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** How long the overlay stays up after the mouse stops moving over the video. */
const HIDE_AFTER_MS = 2400;

/**
 * The match player: the video plus every review control, drawn over the picture
 * rather than under it.
 *
 * The native controls are off. Everything they gave us (scrub, clock, volume,
 * fullscreen) is here alongside the things they never did — quarter speed, frame
 * step, ±5s, next rally — so the whole review kit is one overlay that appears on
 * hover and gets out of the way while the rally is playing. Below the video that
 * kit cost a strip of vertical space on every screen, which is the space the AI
 * breakdown now occupies.
 *
 * Playback state lives on the element and is read back through its own events,
 * so a keyboard shortcut handled by the page and a click on a chip here can't
 * drift apart.
 */
export function VideoPlayer({
  src,
  poster,
  videoRef,
  currentTime,
  paused,
  speed,
  showNextRally,
  hasNextRally,
  isFullscreen,
  onSpeedChange,
  onStepFrames,
  onSeekBy,
  onTogglePlay,
  onNextRally,
  onToggleFullscreen,
  onPlay,
  onPause,
  onTimeChange,
  onLoadedMetadata,
}: {
  src: string;
  poster?: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Playback position, owned by the page (the timeline needs it too). */
  currentTime: number;
  paused: boolean;
  speed: number;
  /** The match has a breakdown, so a "next rally" jump means something. */
  showNextRally: boolean;
  hasNextRally: boolean;
  isFullscreen: boolean;
  onSpeedChange: (s: number) => void;
  onStepFrames: (frames: number) => void;
  onSeekBy: (deltaSeconds: number) => void;
  onTogglePlay: () => void;
  onNextRally: () => void;
  onToggleFullscreen: () => void;
  onPlay: () => void;
  onPause: () => void;
  onTimeChange: (seconds: number) => void;
  onLoadedMetadata: (el: HTMLVideoElement) => void;
}) {
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [scrubbing, setScrubbing] = useState(false);
  /** Pointer moved over the player recently — the reason the overlay is up. */
  const [pointerActive, setPointerActive] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A paused video is being looked at, not watched: the controls stay. While it
  // plays they follow the mouse, and a drag on the scrubber pins them.
  const overlayVisible = paused || pointerActive || scrubbing;

  const wake = useCallback(() => {
    setPointerActive(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPointerActive(false), HIDE_AFTER_MS);
  }, []);

  const sleep = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setPointerActive(false);
  }, []);

  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  /** How far the browser has downloaded past the playhead, for the scrub bar. */
  const readBuffered = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const ranges = el.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= el.currentTime && el.currentTime <= ranges.end(i)) {
        setBuffered(ranges.end(i));
        return;
      }
    }
    setBuffered(0);
  }, [videoRef]);

  const pct = (x: number) => `${duration > 0 ? Math.min(100, Math.max(0, (x / duration) * 100)) : 0}%`;

  /** Seek to wherever on the bar the pointer is, and report it up immediately —
   *  waiting for `seeked` makes a drag feel like it's lagging behind the mouse. */
  const seekFromPointer = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const el = videoRef.current;
      const rect = e.currentTarget.getBoundingClientRect();
      if (!el || rect.width <= 0 || !duration) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      const t = Math.min(duration, Math.max(0, ratio * duration));
      el.currentTime = t;
      onTimeChange(t);
    },
    [videoRef, duration, onTimeChange],
  );

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
    // Unmuting a slider someone dragged to zero should make a sound.
    if (!el.muted && el.volume === 0) el.volume = 1;
  }, [videoRef]);

  return (
    <div
      className={`pv ${overlayVisible ? "pv-awake" : ""}`}
      onPointerMove={wake}
      onPointerEnter={wake}
      onPointerLeave={sleep}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        onPlay={onPlay}
        onPause={onPause}
        onClick={onTogglePlay}
        onDoubleClick={onToggleFullscreen}
        onTimeUpdate={(e) => {
          onTimeChange(e.currentTarget.currentTime);
          readBuffered();
        }}
        onSeeked={(e) => onTimeChange(e.currentTarget.currentTime)}
        onProgress={readBuffered}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted);
          setVolume(e.currentTarget.volume);
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration || 0);
          setMuted(e.currentTarget.muted);
          setVolume(e.currentTarget.volume);
          onLoadedMetadata(e.currentTarget);
        }}
      />

      {/* A paused match with the mouse away shows one big target rather than the
          whole control bar, which is what a poster frame wants. */}
      {paused && (
        <button className="pv-center-play" onClick={onTogglePlay} aria-label="Play">
          <PlayIcon size={34} />
        </button>
      )}

      {/* Faded out rather than removed while it sleeps — the chips stay
          reachable by keyboard, and tabbing into one brings the bar back. */}
      <div className="pv-overlay">
        <div
          className="pv-scrub"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={fmtTime(currentTime)}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setScrubbing(true);
            seekFromPointer(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            seekFromPointer(e);
          }}
          onPointerUp={() => setScrubbing(false)}
          onPointerCancel={() => setScrubbing(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") onSeekBy(-5);
            else if (e.key === "ArrowRight") onSeekBy(5);
            else return;
            e.preventDefault();
          }}
        >
          <div className="pv-scrub-track">
            <div className="pv-scrub-buffered" style={{ width: pct(buffered) }} />
            <div className="pv-scrub-fill" style={{ width: pct(currentTime) }} />
          </div>
          <div className="pv-scrub-handle" style={{ left: pct(currentTime) }} />
        </div>

        <div className="pv-bar">
          <div className="group" aria-label="Skip and play">
            <button
              className="chip pv-wide-only"
              onClick={() => onSeekBy(-10)}
              title="Back 10 seconds"
            >
              −10s
            </button>
            <button className="chip" onClick={() => onSeekBy(-5)} title="Back 5 seconds">
              −5s <span className="kbd">j</span>
            </button>
            <button
              className="chip chip-icon"
              onClick={onTogglePlay}
              title={paused ? "Play" : "Pause"}
            >
              {paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}{" "}
              <span className="kbd">k</span>
            </button>
            <button className="chip" onClick={() => onSeekBy(5)} title="Forward 5 seconds">
              +5s <span className="kbd">l</span>
            </button>
            <button
              className="chip pv-wide-only"
              onClick={() => onSeekBy(10)}
              title="Forward 10 seconds"
            >
              +10s
            </button>
          </div>

          <div className="group" aria-label="Frame step">
            <button className="chip chip-icon" onClick={() => onStepFrames(-1)} title="Previous frame">
              <PrevFrameIcon size={16} /> <span className="kbd">,</span>
            </button>
            <button className="chip chip-icon" onClick={() => onStepFrames(1)} title="Next frame">
              <span className="kbd">.</span> <NextFrameIcon size={16} />
            </button>
          </div>

          <span className="pv-clock mono">
            {fmtTime(currentTime)} <span className="pv-clock-sep">/</span> {fmtTime(duration)}
          </span>

          <div className="pv-bar-right">
            <div className="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`chip ${speed === s ? "active" : ""}`}
                  onClick={() => onSpeedChange(s)}
                  title={`${s}× speed`}
                >
                  {s}×
                </button>
              ))}
            </div>

            {showNextRally && (
              <div className="group" aria-label="Rallies">
                <button
                  className="chip chip-icon"
                  onClick={onNextRally}
                  disabled={!hasNextRally}
                  aria-label="Next rally"
                  title="Skip to the start of the next rally"
                >
                  <NextRallyIcon size={15} />
                  {/* On a phone the icon carries it — the words cost a whole
                      extra row of overlay on a 210px-tall video. */}
                  <span className="pv-wide-only">Next rally</span>{" "}
                  <span className="kbd">n</span>
                </button>
              </div>
            )}

            <div className="group pv-volume" aria-label="Volume">
              <button
                className="chip chip-icon"
                onClick={toggleMute}
                title={muted || volume === 0 ? "Unmute" : "Mute"}
              >
                {muted || volume === 0 ? <MuteIcon size={16} /> : <VolumeIcon size={16} />}{" "}
                <span className="kbd">m</span>
              </button>
              <input
                className="pv-volume-slider"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume level"
                onChange={(e) => {
                  const el = videoRef.current;
                  if (!el) return;
                  el.volume = Number(e.target.value);
                  el.muted = Number(e.target.value) === 0;
                }}
              />
            </div>

            <div className="group" aria-label="View">
              <button
                className="chip chip-icon"
                onClick={onToggleFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen (keeps these controls)"}
              >
                {isFullscreen ? <ExitFullscreenIcon size={16} /> : <FullscreenIcon size={16} />}{" "}
                <span className="kbd">f</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
