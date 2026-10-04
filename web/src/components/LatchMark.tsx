/** The padlock-with-pin mark. `animated` closes the shackle once on mount. */
export function LatchMark({ animated = false, className = "" }: { animated?: boolean; className?: string }) {
  return (
    <svg
      className={`latch-mark ${animated ? "is-animated" : ""} ${className}`}
      viewBox="0 0 200 220"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="shackle"
        d="M64 78 V52 a36 36 0 0 1 72 0 V78"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <rect x="38" y="78" width="124" height="118" rx="18" stroke="currentColor" strokeWidth="3" />
      <circle cx="100" cy="132" r="14" stroke="currentColor" strokeWidth="3" />
      <path d="M100 146 v28" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path
        className="pin"
        d="M168 118 h22 a8 8 0 0 1 0 16 h-22"
        stroke="currentColor"
        strokeWidth="3"
      />
    </svg>
  );
}
