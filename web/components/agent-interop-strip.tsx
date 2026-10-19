import { AgentMark } from "@web/components/agent-mark"
import { Icon } from "@web/components/icon"
import type { AgentInteropCopy } from "@web/content/types"

interface AgentInteropStripProps {
  copy: AgentInteropCopy
  /** Cell background; must match the surrounding section's tone. */
  tone?: "paper" | "surface"
}

/**
 * "Does it work with the agent I already use?" (spec §4.6, amended 2026-08-01)
 *
 * Every row is backed by real code — an external-agent preset, a
 * session-import adapter, or both — and the two capability marks say which, so
 * no row implies more than it has.
 *
 * §4.5 rules out a model logo wall and §4.6 rules out a scrolling ticker; this
 * is neither. The marks are monochrome and inherit the page's ink, the rows
 * are a static index, and the capability is stated in words beside each name
 * rather than implied by the presence of a logo.
 *
 * It sits with the run strategies on the homepage and with the agents on
 * /product: both are answers to "what runs the work".
 */
export function AgentInteropStrip({ copy, tone = "paper" }: AgentInteropStripProps) {
  const cell = tone === "paper" ? "bg-paper" : "bg-surface"
  return (
    <div data-slot="agent-interop" className="border-t border-hairline pt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-10 gap-y-3">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.label}</p>
        <p className="max-w-xl text-sm leading-relaxed text-muted">{copy.note}</p>
      </div>

      <ul
        aria-label={copy.label}
        className="mt-8 grid grid-cols-2 gap-px border-y border-hairline bg-hairline xl:grid-cols-5"
      >
        {copy.items.map((agent) => (
          <li key={agent.id} className={`trace flex flex-col gap-3 p-5 ${cell}`}>
            <span className="flex items-center gap-2.5">
              <AgentMark id={agent.id} className="shrink-0 text-ink" />
              <span className="text-sm font-medium text-ink">{agent.name}</span>
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs uppercase tracking-widest text-muted">
              {agent.run ? (
                <span className="flex items-center gap-1">
                  <Icon name="play" size={14} />
                  {copy.runLabel}
                </span>
              ) : null}
              {agent.import ? (
                <span className="flex items-center gap-1">
                  <Icon name="record" size={14} />
                  {copy.importLabel}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
