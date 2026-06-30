import React from "react"
import { Box, Text, type DOMElement } from "ink"

import { Banner } from "../Banner"
import { ScrollView } from "../ScrollView"
import { Transcript } from "../Transcript"
import { Inflight } from "../Inflight"
import { WorkflowRunPanel } from "../WorkflowRunPanel"
import { contextPercent } from "../../format/usage"
import { VERSION } from "../../../version"
import type { TuiState } from "../../state/types"
import type { ScrollController } from "../../hooks/useScroll"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"

export interface TranscriptRegionProps {
  state: TuiState
  /** Effective layout: fullscreen pins a status banner + own scroll viewport;
   * scrollback prints the transcript into the terminal's native scrollback. */
  fullscreen: boolean
  /** Memoized welcome banner — the scrollback transcript header. */
  banner: React.ReactNode
  /** Active model id (catalog-resolved), for the fullscreen status banner. */
  activeModel: string | undefined
  /** Fullscreen scroll controller (no-op in scrollback mode). */
  scroll: ScrollController
  /** Content box of the scroll viewport, for click-to-expand row mapping. */
  scrollContentRef: React.RefObject<DOMElement | null>
  /** Find/click cursor — drives focus highlight + per-cell measurement. */
  cursor: TranscriptCursor
  /** `themePalette.muted` — colour of the "scrolled up" hint. */
  mutedColor: string
}

/**
 * The transcript region: history + the live turn. In fullscreen it pins a status
 * banner above an app-managed scroll viewport (with a "scrolled up" hint); in
 * scrollback mode it prints straight into the terminal's native scrollback with
 * the welcome banner as the header. The in-flight tools + workflow-run panel
 * follow the transcript in both layouts.
 */
export function TranscriptRegion({
  state,
  fullscreen,
  banner,
  activeModel,
  scroll,
  scrollContentRef,
  cursor,
  mutedColor,
}: TranscriptRegionProps): React.ReactElement {
  if (fullscreen) {
    return (
      <>
        {/* Fixed top banner — rendered outside the scroll viewport so it never
            scrolls away (the whole point of fullscreen). It carries a live status
            line (mode / context / tokens) since, unlike the scrollback banner, it
            stays on screen for the whole session. */}
        <Banner
          version={VERSION}
          provider={state.config.provider}
          model={activeModel}
          cwd={state.config.cwd}
          status={{
            mode: state.config.permissionMode,
            contextPct: contextPercent(state.usage, activeModel, state.modelMeta?.contextWindow),
            sessionTokens: state.sessionTotals.inputTokens + state.sessionTotals.outputTokens,
          }}
        />
        {/* Scrollable middle: history + the live turn, clipped to the space
            between the banner and the composer. */}
        <ScrollView offset={scroll.offset} onMeasure={scroll.measure} contentRef={scrollContentRef}>
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
          />
          <Inflight inflight={state.inflight} verbose={state.verbose} />
          <WorkflowRunPanel run={state.workflowRun} />
        </ScrollView>
        {/* "Scrolled up" hint — only while the view isn't pinned to the bottom,
            so a following transcript shows nothing. */}
        {!scroll.atBottom && (
          <Box flexShrink={0}>
            <Text color={mutedColor} dimColor>
              {`↑ ${scroll.hidden.below} more line${scroll.hidden.below === 1 ? "" : "s"} below · End to jump to latest`}
            </Text>
          </Box>
        )}
      </>
    )
  }

  return (
    <>
      <Transcript
        cells={state.cells}
        header={banner}
        verbose={state.verbose}
        epoch={state.renderEpoch}
        focusedCellId={state.backtrack ? (state.cells[state.backtrack.index]?.id ?? null) : null}
      />
      <Inflight inflight={state.inflight} verbose={state.verbose} />
      <WorkflowRunPanel run={state.workflowRun} />
    </>
  )
}
