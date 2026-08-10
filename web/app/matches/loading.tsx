import { MatchGridSkeleton, ProfileHeaderSkeleton } from "../Skeleton";

/** Shown while the server component fetches the library. */
export default function Loading() {
  return (
    <div>
      <ProfileHeaderSkeleton />
      <MatchGridSkeleton />
    </div>
  );
}
