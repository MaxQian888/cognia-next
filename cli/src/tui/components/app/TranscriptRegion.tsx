import React from "react"
import { Box, Text, type DOMElement } from "ink"

import { Banner } from "../Banner"
import { ScrollView } from "../ScrollView"
import { Transcript } from "../Transcript"
import { VirtualizedTranscript } from "../VirtualizedTranscript"
import { Inflight } from "../Inflight"
import { WorkflowRunPanel } from "../WorkflowRunPanel"
import { contextPercent } from "../../format/usage"
import { externalWithoutKnownWindow } from "../../format/status-bar"
import type { BackendIdentity } from "../../runtime/backend-identity"
import { VERSION } from "../../../version"
import type { TuiState } from "../../state/types"
import type { ScrollController } from "../../hooks/useScroll"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import type { TerminalLayoutBudget } from "../../layout/terminal-layout"

export interface TranscriptRegionProps {
  state: TuiState
  /** Effective layout: fullscreen shows a welcome banner + own scroll viewport;
   * scrollback prints the transcript into the terminal's native scrollback. */
  fullscreen: boolean
  /** Memoized welcome banner — the scrollback transcript header. */
  banner: React.ReactNode
  /** Who is actually answering. The fullscreen welcome uses the same resolved identity the
   * scrollback banner and the footer use — never the raw built-in config. */
  identity: BackendIdentity
  /** Active model id (catalog-resolved). Only used to price the built-in
   * context gauge; the displayed model comes from {@link identity}. */
  activeModel: string | undefined
  columns?: number
  /** Fullscreen scroll controller (no-op in scrollback mode). */
  scroll: ScrollController
  /** Content box of the scroll viewport, for click-to-expand row mapping. */
  scrollContentRef: React.RefObject<DOMElement | null>
  /** Find/click cursor — drives focus highlight + per-cell measurement. */
  cursor: TranscriptCursor
  /** `themePalette.muted` — colour of the "scrolled up" hint. */
  mutedColor: string
  layout?: TerminalLayoutBudget
}

/**
 * Static tracks its append position by index, so removing a previously printed
 * header slot would skip the first user cell. Latch the slot for each replay;
 * a new session or replay mounts fresh and can omit an obsolete welcome.
 */
function ScrollbackTranscript(props: React.ComponentProps<typeof Transcript>) {
  const [hasHeaderSlot] = React.useState(() => Boolean(props.header))
  const [lastHeader, setLastHeader] = React.useState(props.header)
  // Keep startup identity current until the first user arrives. Afterwards the
  // existing slot retains its last content without shifting Static's indices.
  if (hasHeaderSlot && props.header !== undefined && props.header !== lastHeader) {
    setLastHeader(props.header)
  }
  const header = hasHeaderSlot ? <>{props.header ?? lastHeader}</> : undefined
  return <Transcript {...props} header={header} />
}

/** History + live turn. Welcome is shown only before the first user message. */
export function TranscriptRegion({
  state,
  fullscreen,
  banner,
  identity,
  activeModel,
  columns = 80,
  scroll,
  scrollContentRef,
  cursor,
  mutedColor,
  layout = {
    tier: "full",
    bannerDensity: "full",
    showBanner: true,
    showMascot: true,
    showFooterHint: true,
    composerRows: 3,
  },
}: TranscriptRegionProps): React.ReactElement {
  const hasUserMessage = state.cells.some((cell) => cell.kind === "user")
  if (fullscreen) {
    const virtualized = process.env.COGNIA_TUI_RENDERER !== "legacy"
    return (
      <>
        {/* Once conversation starts, the footer already carries this status. */}
        {layout.showBanner && !hasUserMessage ? (
          <Banner
            version={VERSION}
            provider={identity.provider}
            {...(identity.model ? { model: identity.model } : {})}
            cwd={state.config.cwd}
            density={layout.bannerDensity}
            status={{
              mode: state.config.permissionMode,
              // Dropped when an external agent answers and no one has told us its
              // context window: the percentage would be derived from the built-in
              // provider's catalog window, which says nothing about that agent.
              // Same rule (and same helper) as the footer's `ctx` segment — this
              // welcome header must follow the same identity rule.
              ...(externalWithoutKnownWindow(state.config, state.modelMeta?.contextWindow)
                ? {}
                : {
                    contextPct: contextPercent(
                      state.usage,
                      activeModel,
                      state.modelMeta?.contextWindow
                    ),
                  }),
              sessionTokens: state.sessionTotals.inputTokens + state.sessionTotals.outputTokens,
            }}
          />
        ) : null}
        {/* Scrollable middle: history + the live turn, clipped to the space
            between the banner and the composer. */}
        <ScrollView offset={scroll.offset} onMeasure={scroll.measure} contentRef={scrollContentRef}>
          {virtualized && !cursor.measuring && !state.backtrack ? (
            <VirtualizedTranscript
              cells={state.cells}
              width={columns}
              top={scroll.offset}
              viewportRows={scroll.viewportRows}
              verbose={state.verbose}
              onMetrics={scroll.setBlockMetrics}
            />
          ) : (
            <Transcript
              cells={state.cells}
              verbose={state.verbose}
              mode="live"
              measuring={cursor.measuring}
              focusedCellId={
                (state.backtrack ? state.cells[state.backtrack.index]?.id : undefined) ??
                cursor.state.focusedCellId
              }
              onCellHeight={cursor.reportCellHeight}
              columns={columns}
            />
          )}
          <Inflight
            inflight={state.inflight}
            pending={state.pendingCells}
            awaitingApproval={state.overlay.kind === "permission"}
            verbose={state.verbose}
            epoch={state.streamEpoch}
            columns={columns}
          />
          <WorkflowRunPanel run={state.workflowRun} />
        </ScrollView>
        {/* "Scrolled up" hint — only while the view isn't pinned to the bottom,
            so a following transcript shows nothing. */}
        {!scroll.atBottom && (
          <Box flexShrink={0}>
            <Text color={mutedColor} dimColor>
              {`↑ ${scroll.hidden.below} more line${scroll.hidden.below === 1 ? "" : "s"} below${scroll.newRowsBelow > 0 ? ` · ${scroll.newRowsBelow} new` : ""} · End to jump to latest`}
            </Text>
          </Box>
        )}
      </>
    )
  }

  return (
    <>
      <ScrollbackTranscript
        key={`${state.sessionId}:${state.renderEpoch}`}
        cells={state.cells}
        header={hasUserMessage ? undefined : banner}
        verbose={state.verbose}
        epoch={state.renderEpoch}
        replayMaxRows={state.config.render?.terminalResizeReplayMaxRows ?? 10_000}
        focusedCellId={state.backtrack ? (state.cells[state.backtrack.index]?.id ?? null) : null}
        columns={columns}
      />
      <Inflight
        inflight={state.inflight}
        pending={state.pendingCells}
        awaitingApproval={state.overlay.kind === "permission"}
        verbose={state.verbose}
        epoch={state.streamEpoch}
        columns={columns}
      />
      <WorkflowRunPanel run={state.workflowRun} />
    </>
  )
}
