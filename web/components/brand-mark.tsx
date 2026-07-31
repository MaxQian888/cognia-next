interface BrandMarkProps {
  className?: string
  size?: number
}

/**
 * The Cognia mark.
 *
 * The wordmark alone was a line of monospaced text, which read as a placeholder
 * rather than as an identity. This is the smallest thing that fixes that
 * without reaching for what spec §3.1 forbids: no purple-blue AI gradient, no
 * second palette, no glow.
 *
 * It is built from the page's own vocabulary (§2.4, "tool / precision
 * instrument"):
 *
 * - a **square aperture** rather than a circle — the workspace boundary that
 *   every product panel on the site also draws, at `radius-control`'s corner;
 * - **four registration ticks** breaking that boundary at the cardinals, the
 *   measurement marks the whole page is made of;
 * - a **context path** entering from the left, turning once, and stopping at a
 *   node just past centre — the same Source → Action → Permission → Result
 *   thread the Trust rail draws, and the same beat as the signature demo
 *   halting at approval.
 *
 * Only the node is `action` cyan, and it is a dot: §3.1's rule is that cyan is
 * a line, a dot or a fill, never a text colour, and the whole mark keeps the
 * accent well under the 5% budget. Everything else inherits `currentColor`, so
 * the mark flips with the theme instead of needing a light and a dark copy.
 *
 * `aria-hidden`, because the brand link beside it already carries the word
 * "Cognia" as text; announcing both would say the name twice.
 */
export function BrandMark({ className, size = 20 }: BrandMarkProps) {
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
      {/* The workspace boundary. */}
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
      {/* Registration ticks: the instrument's own marks, at the cardinals. */}
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.9">
        <path d="M12 1.5v2.4" />
        <path d="M12 20.1v2.4" />
        <path d="M1.5 12h2.4" />
        <path d="M20.1 12h2.4" />
      </g>
      {/* The context path: in from the edge, one turn, stop at the node. */}
      <path
        d="M6.9 9.1h3.4a1.6 1.6 0 0 1 1.6 1.6v3.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Where it stops. The only cyan in the mark. */}
      <circle cx="11.9" cy="15.9" r="1.75" fill="var(--color-action)" />
    </svg>
  )
}
