/**
 * The persistent bottom region beneath the transcript + overlays: the in-flight
 * status line, the find bar, the backtrack/edit status notices, the composer,
 * the mascot, and the footer. Lifted out of {@link App} (which still owns the
 * state + callbacks) so the root render reads as named regions. The handlers are
 * threaded verbatim, so behaviour is unchanged.
 */
import React from "react"
import { Box, Text, type DOMElement } from "ink"

import { BottomStatus, type AgentTreeHit } from "../BottomStatus"
import { Toasts } from "../Toasts"
import { useToastExpiry } from "./use-toast-expiry"
import { FindBar } from "../FindBar"
import { Input } from "../Input"
import { Mascot } from "../Mascot"
import { Footer } from "../Footer"
import { selectMascotMood } from "../../mascot/mascot"
import { userMessageStats } from "./app-helpers"
import { resolveKeybindings } from "../../input/keybindings"
import { runningSubagents } from "../../format/subagent"
import type { StatusSegmentView } from "../../format/status-bar"
import type { ListDir } from "../../commands/file-completer"
import type { MentionProviders } from "../../mention/providers"
import type { TuiState, TuiAction } from "../../state/types"
import type { Dispatch } from "react"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"

export interface BottomRegionProps {
  state: TuiState
  dispatch: Dispatch<TuiAction>
  cursor: TranscriptCursor
  overlayOpen: boolean
  columns: number
  popupRows: number
  /** `themePalette.warning` — colour of the backtrack/edit status notices. */
  warningColor: string
  // BottomStatus
  streamStartedAt: number | null
  lastActivityAt: number | null
  footerSubagentRunning: ReturnType<typeof runningSubagents>
  footerBackgroundSubagents: number
  interruptedBackgroundSubagents: number
  footerCopilot: { name: string } | undefined
  backtrackArmed: boolean
  subagentChipRef: React.RefObject<DOMElement | null>
  /** Hit-test state for clicks on the running-agents tree (App mouse handler). */
  agentTreeRef: React.MutableRefObject<AgentTreeHit | null>
  // Input (composer)
  handleSubmit: (text: string) => void
  handleHistoryPush: (entry: string) => void
  listDir?: ListDir
  mentionProviders: MentionProviders
  keybindings: ReturnType<typeof resolveKeybindings>
  enabledSkillIds: Set<string>
  toggleSkillEnabled: (id: string, enabled: boolean) => void
  handlePopupOpenChange: (open: boolean) => void
  // Footer
  footerPlanTitle: string | undefined
  footerRowRef: React.RefObject<DOMElement | null>
  footerSegmentsRef: React.MutableRefObject<StatusSegmentView[] | null>
}

export function BottomRegion(props: BottomRegionProps): React.ReactElement {
  const {
    state,
    dispatch,
    cursor,
    overlayOpen,
    columns,
    popupRows,
    warningColor,
    streamStartedAt,
    lastActivityAt,
    footerSubagentRunning,
    footerBackgroundSubagents,
    interruptedBackgroundSubagents,
    footerCopilot,
    backtrackArmed,
    subagentChipRef,
    agentTreeRef,
    handleSubmit,
    handleHistoryPush,
    listDir,
    mentionProviders,
    keybindings,
    enabledSkillIds,
    toggleSkillEnabled,
    handlePopupOpenChange,
    footerPlanTitle,
    footerRowRef,
    footerSegmentsRef,
  } = props

  // Auto-expire transient toasts (severity-dependent TTL). The reducer stays
  // pure; the timing lives here with the render that shows them.
  useToastExpiry(state.toasts, dispatch)

  return (
    <>
      <Toasts toasts={state.toasts} />
      <BottomStatus
        turnStatus={state.turnStatus}
        activity={state.activity}
        tools={state.inflight.tools}
        steerQueue={state.steerQueue}
        since={streamStartedAt}
        lastActivityAt={lastActivityAt}
        subagentRunning={footerSubagentRunning}
        backgroundSubagents={footerBackgroundSubagents}
        interruptedBackgroundSubagents={interruptedBackgroundSubagents}
        copilot={footerCopilot}
        verbose={state.verbose}
        backtrackArmed={backtrackArmed}
        columns={columns}
        chipRowRef={subagentChipRef}
        sessionId={state.sessionId}
        agentTreeRef={agentTreeRef}
      />
      {cursor.state.find && (
        <FindBar
          query={cursor.state.find.query}
          matchCount={cursor.matchCount}
          matchIndex={cursor.matchIndex}
        />
      )}
      {/* Backtrack-to-edit status: while selecting, the composer is inert and
          ↑/↓ choose a message (shown as #position/total so it reads even in
          scrollback mode, where the transcript can't highlight the cell); once
          a target is committed, warn how many later turns the edit discards. */}
      {state.backtrack &&
        (() => {
          const { pos, total } = userMessageStats(state.cells, state.backtrack.index)
          return (
            <Box flexShrink={0}>
              <Text color={warningColor}>
                {`✎ Editing message #${pos}/${total} — ↑/↓ choose · Enter to edit · Esc to cancel`}
              </Text>
            </Box>
          )
        })()}
      {state.editTarget &&
        (() => {
          const { pos, total, later } = userMessageStats(state.cells, state.editTarget.index)
          return (
            <Box flexShrink={0}>
              <Text color={warningColor}>
                {`✎ Editing message #${pos}/${total} · ${later} later turn(s) will be discarded on send · Esc to cancel`}
              </Text>
            </Box>
          )
        })()}
      {!overlayOpen && !cursor.state.find && (
        <Input
          input={state.input}
          dispatch={dispatch}
          onSubmit={handleSubmit}
          onHistoryPush={handleHistoryPush}
          // Inert while a backtrack-to-edit selection is active (App owns ↑/↓/
          // Enter then); otherwise stays active even during a turn so a `btw`
          // steer can be typed mid-stream (`handleSubmit` queues it).
          disabled={!!state.backtrack}
          cwd={state.config.cwd}
          listDir={listDir}
          mentionProviders={mentionProviders}
          width={columns}
          popupRows={popupRows}
          keybindings={keybindings}
          mode={state.config.permissionMode}
          vimEnabled={state.config.vim === true}
          enabledSkillIds={enabledSkillIds}
          onToggleSkill={toggleSkillEnabled}
          onPopupOpenChange={handlePopupOpenChange}
        />
      )}
      <Mascot
        mood={selectMascotMood({
          turnStatus: state.turnStatus,
          hasThinking: state.inflight.thinking.length > 0,
          activityRunning: state.activity?.status === "running",
        })}
        style={state.config.mascot?.style ?? "clawd"}
        enabled={state.config.mascot?.enabled !== false}
      />
      <Footer
        config={state.config}
        usage={state.usage}
        totals={state.sessionTotals}
        contextWindow={state.modelMeta?.contextWindow}
        rateLimits={state.rateLimits}
        turnStatus={state.turnStatus}
        planTitle={footerPlanTitle}
        columns={columns}
        rowRef={footerRowRef}
        segmentsRef={footerSegmentsRef}
      />
    </>
  )
}
