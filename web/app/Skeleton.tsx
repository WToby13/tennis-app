/**
 * Loading placeholders that hold the shape of the content they stand in for, so
 * the page doesn't jump when it arrives. Purely presentational — no client JS.
 */

/** One match card's worth of placeholder. */
export function MatchCardSkeleton() {
  return (
    <div className="card" aria-hidden="true">
      <div className="skeleton skeleton-thumb" />
      <div style={{ padding: 14 }}>
        <div className="skeleton skeleton-line" style={{ width: "70%" }} />
        <div className="skeleton skeleton-line" style={{ width: "45%" }} />
        <div className="skeleton skeleton-line" style={{ width: "30%", marginTop: 14 }} />
      </div>
    </div>
  );
}

/** A grid of card placeholders, matching the library/feed layout. */
export function MatchGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid" style={{ marginTop: 24 }} role="status" aria-label="Loading matches">
      {Array.from({ length: count }, (_, i) => (
        <MatchCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** The library page's profile strip, while the profile is in flight. */
export function ProfileHeaderSkeleton() {
  return (
    <div className="library-header" aria-hidden="true">
      <div className="skeleton" style={{ width: 56, height: 56, borderRadius: "50%" }} />
      <div className="who">
        <div className="skeleton skeleton-line" style={{ width: 180, height: 20 }} />
        <div className="skeleton skeleton-line" style={{ width: 240 }} />
      </div>
    </div>
  );
}
