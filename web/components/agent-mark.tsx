import manifest from "@web/content/generated/agent-icons.json"
import { Icon } from "@web/components/icon"

interface AgentIconPath {
  d: string
  fillRule?: string
  clipRule?: string
}

interface AgentIcon {
  source: string
  viewBox: string
  title: string | null
  paths: AgentIconPath[]
}

const ICONS = manifest.icons as Record<string, AgentIcon | undefined>

interface AgentMarkProps {
  /** Matches a key in `content/generated/agent-icons.json`. */
  id: string
  className?: string
}

/**
 * A vendored brand mark for one interoperating agent.
 *
 * Drawn inline from extracted path data rather than loaded as an image element,
 * because the source marks are `fill="currentColor"` monochrome: inline they
 * inherit the surrounding token and stay legible in both the paper and the
 * graphite modes, where a bitmap or an externally loaded SVG would be stuck at one
 * lightness and go invisible in the other.
 *
 * Always `aria-hidden`. The agent's name sits beside it as real text, so
 * announcing the mark as well would read the same thing twice. An agent with no
 * vendored mark falls back to the site's own generic glyph rather than
 * borrowing another brand's — see `scripts/sync-agent-icons.mjs`.
 */
export function AgentMark({ id, className }: AgentMarkProps) {
  const icon = ICONS[id]

  if (!icon) {
    return <Icon name="agents" size={16} className={className} />
  }

  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={icon.viewBox}
      width={16}
      height={16}
      fill="currentColor"
      className={className}
    >
      {icon.paths.map((path) => (
        <path
          key={path.d}
          d={path.d}
          fillRule={path.fillRule as "evenodd" | "nonzero" | undefined}
          clipRule={path.clipRule as "evenodd" | "nonzero" | undefined}
        />
      ))}
    </svg>
  )
}
