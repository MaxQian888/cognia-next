/**
 * The live "agent run page" — switch into one sub-agent's run and watch its
 * streamed reasoning, tool activity, and reply text token-by-token (Claude
 * Code's subagent transcript). Opened from the `/agents` panel (Enter / click a
 * running row).
 *
 * Content is read live from the {@link subagent-live-output} store by `liveId`:
 * while the run is `running` the page polls the store on a short interval and
 * re-renders as the entry's `version` grows; once settled it stops polling. The
 * body scrolls with the shared {@link usePanelScroll} viewport (↑/↓ · PgUp/PgDn ·
 * wheel); Esc closes. Wall-clock + store reads are injectable so it unit-tests
 * without timers or a sidecar.
 */
import React from "react"
import { Box, Text, useInput, useStdout, type Key } from "ink"

import {
  PANEL_CHROME_ROWS,
  PanelViewport,
  panelFooterHint,
  usePanelScroll,
} from "../../hooks/usePanelScroll"
import { useTheme } from "../../theme/context"
import { parseMouseEvent } from "../../input/mouse"
import { agentRowBadge, formatElapsed, type AgentRowStatus } from "../../runtime/agents-panel-model"
import { getLiveSubagent, type SubagentLiveEntry } from "../../../agent/subagent-live-output"

export interface AgentRunPageProps {
  liveId: string
  name: string
  task: string
  /** Read the live entry (defaults to the store); App binds it to the owner session. */
  getEntry?: (liveId: string) => SubagentLiveEntry | undefined
  onClose: () => void
  /** Wall clock for elapsed text; injectable so tests stay deterministic. */
  now?: number
  isActive?: boolean
  width?: number | string
  /** Test seam: viewport height in rows (defaults to the terminal height). */
  viewportRows?: number
  /** Poll cadence while the run is in flight. */
  pollMs?: number
}

/** A minimal Ink `Key` with just the field the scroll controller reads. */
function scrollKey(field: "upArrow" | "downArrow"): Key {
  return { [field]: true } as unknown as Key
}

export function AgentRunPage({
  liveId,
  name,
  task,
  getEntry = getLiveSubagent,
  onClose,
  now: nowProp,
  isActive = true,
  width,
  viewportRows,
  pollMs = 300,
}: AgentRunPageProps): React.ReactElement {
  const theme = useTheme()
  const { stdout } = useStdout()
  const viewport =
    viewportRows ?? Math.max(4, ((stdout?.rows as number | undefined) ?? 24) - PANEL_CHROME_ROWS)
  const scroll = usePanelScroll(viewport)
  const [, setTick] = React.useState(0)
  // Self-ticking wall clock for elapsed text when uncontrolled; a provided `now`
  // pins it for deterministic tests. Date.now() must be read in a state
  // initializer / effect — not during render (react-hooks/purity).
  const [nowTick, setNowTick] = React.useState(() => Date.now())
  const now = nowProp ?? nowTick

  const entry = getEntry(liveId)
  const status: AgentRowStatus = entry?.status ?? "running"

  // Poll the live store while the run is in flight; stop once it settles.
  React.useEffect(() => {
    if (!isActive || status !== "running") return
    const handle = setInterval(() => {
      setTick((t) => t + 1)
      // Advance the elapsed clock alongside the poll when uncontrolled.
      if (nowProp === undefined) setNowTick(Date.now())
    }, pollMs)
    return () => clearInterval(handle)
  }, [isActive, status, pollMs, liveId, getEntry, nowProp])

  useInput(
    (input, key) => {
      if (key.escape || key.return) return onClose()
      const mouse = parseMouseEvent(input)
      if (mouse) {
        if (mouse.kind === "wheel")
          scroll.onKey("", scrollKey(mouse.dir === "up" ? "upArrow" : "downArrow"))
        return
      }
      scroll.onKey(input, key)
    },
    { isActive }
  )

  const badge = agentRowBadge(status)
  const elapsed =
    entry?.startedAt !== undefined
      ? formatElapsed((entry.settledAt ?? now) - entry.startedAt)
      : null
  const hasBody =
    !!entry && (entry.text.length > 0 || entry.thinking.length > 0 || entry.tools.length > 0)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold>
        Agent · <Text color={theme[badge.token]}>{badge.glyph}</Text> {name}
        <Text color={theme.muted}>
          {" "}
          · {status}
          {elapsed ? ` · ${elapsed}` : ""}
        </Text>
      </Text>
      {task ? (
        <Text color={theme.muted} dimColor>
          {task.replace(/\s+/g, " ").slice(0, 200)}
        </Text>
      ) : null}
      <PanelViewport viewportRows={viewport} scroll={scroll}>
        {!entry ? (
          <Text color={theme.muted} dimColor>
            no live output for this run.
          </Text>
        ) : !hasBody ? (
          <Text color={theme.muted} dimColor>
            waiting for first output…
          </Text>
        ) : (
          <>
            {entry.thinking ? (
              <Box flexDirection="column">
                <Text color={theme.muted}>Thinking</Text>
                <Text color={theme.muted} dimColor>
                  {entry.thinking}
                </Text>
              </Box>
            ) : null}
            {entry.tools.length > 0 ? (
              <Box flexDirection="column" marginTop={entry.thinking ? 1 : 0}>
                <Text color={theme.muted}>Tools</Text>
                {entry.tools.map((tool, i) => {
                  const toolBadge = agentRowBadge(tool.status)
                  return (
                    <Text key={`${tool.id ?? tool.name}-${i}`}>
                      {"  "}
                      <Text color={theme[toolBadge.token]}>{toolBadge.glyph}</Text> {tool.name}
                    </Text>
                  )
                })}
              </Box>
            ) : null}
            {entry.text ? (
              <Box marginTop={entry.thinking || entry.tools.length > 0 ? 1 : 0}>
                <Text>{entry.text}</Text>
              </Box>
            ) : null}
          </>
        )}
      </PanelViewport>
      <Text color={theme.muted} dimColor>
        {panelFooterHint(scroll.hidden)} · esc close
      </Text>
    </Box>
  )
}
