/**
 * The Cognia mark, drawn the same way as the website's
 * (`web/components/brand-mark.tsx`) so the two sites read as one product. The
 * docs app cannot import across packages, hence the copy: a square aperture,
 * four registration ticks, a context path that stops at a cyan node. Everything
 * but the node inherits `currentColor`, so it flips with the theme.
 *
 * `aria-hidden`: it always sits beside the word "Cognia".
 */
export function BrandMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <rect
        x="3.25"
        y="3.25"
        width="17.5"
        height="17.5"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.55"
      />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.9">
        <path d="M12 1.5v2.4" />
        <path d="M12 20.1v2.4" />
        <path d="M1.5 12h2.4" />
        <path d="M20.1 12h2.4" />
      </g>
      <path
        d="M6.9 9.1h3.4a1.6 1.6 0 0 1 1.6 1.6v3.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="11.9" cy="15.9" r="1.75" fill="var(--cg-action)" />
    </svg>
  )
}
