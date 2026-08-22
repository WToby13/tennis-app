/**
 * Small line icons (24×24, stroke = currentColor). Used everywhere instead of
 * emojis so the UI reads consistently. Pass `filled` to solid-fill where noted.
 */
type P = { size?: number; className?: string };

function svg(size: number, children: React.ReactNode, extra?: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...extra}
    >
      {children}
    </svg>
  );
}

export const HeartIcon = ({ size = 24, filled = false }: P & { filled?: boolean }) =>
  svg(
    size,
    <path d="M12 20.5 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 0 1 19.4 13z" />,
    filled ? { fill: "currentColor", stroke: "currentColor" } : undefined,
  );

export const CommentIcon = ({ size = 24 }: P) =>
  svg(size, <path d="M21 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-3.9A7.5 7.5 0 1 1 21 11.5z" />);

export const ShareIcon = ({ size = 24 }: P) =>
  svg(
    size,
    <>
      <path d="M9.5 13.5 15 8" />
      <path d="M14 6.5 15.5 5a3 3 0 0 1 4.2 4.2l-2.3 2.3a3 3 0 0 1-4.2 0" />
      <path d="M10 17.5 8.5 19a3 3 0 0 1-4.2-4.2l2.3-2.3a3 3 0 0 1 4.2 0" />
    </>,
  );

export const BookmarkIcon = ({ size = 24, filled = false }: P & { filled?: boolean }) =>
  svg(
    size,
    <path d="M6 4.5h12v15l-6-4-6 4z" />,
    filled ? { fill: "currentColor", stroke: "currentColor" } : undefined,
  );

export const PlayIcon = ({ size = 24 }: P) => svg(size, <path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="currentColor" />);
export const PauseIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M8.5 5.5v13" /><path d="M15.5 5.5v13" /></>);

export const PrevFrameIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M18 6v12l-9-6z" fill="currentColor" stroke="currentColor" /><path d="M6 5.5v13" /></>);
export const NextFrameIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M6 6v12l9-6z" fill="currentColor" stroke="currentColor" /><path d="M18 5.5v13" /></>);

export const EditIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.5z" /><path d="M14.5 8.5 16 10" /></>);

export const TrashIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M4 7h16" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" /><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" /></>);

export const CloseIcon = ({ size = 24 }: P) => svg(size, <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>);

export const PlusIcon = ({ size = 24 }: P) => svg(size, <><path d="M12 5v14" /><path d="M5 12h14" /></>);

export const HomeIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /></>);
export const GridIcon = ({ size = 24 }: P) =>
  svg(size, <><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></>);
export const UploadIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></>);
export const BellIcon = ({ size = 24 }: P) =>
  svg(
    size,
    <>
      <path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15z" />
      <path d="M10 21h4" />
    </>,
  );

export const ProfileIcon = ({ size = 24 }: P) =>
  svg(size, <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" /></>);
