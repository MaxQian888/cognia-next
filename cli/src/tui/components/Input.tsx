import { useCliTranslations } from "../i18n"
/**
 * The composer: a multiline editor with command history, a `/` command palette,
 * `@` file-path completion, and large-paste collapsing. All editing/keymap logic
 * is pure (`input/*`, `commands/*`); this component wires those to Ink's
 * the routed composer input handler and reducer state, and renders the buffer + popups.
 *
 * Global keys (Ctrl+C exit, Esc-while-busy interrupt) are owned by the App; this
 * handler treats `exit`/`interrupt` intents as no-ops.
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { openBrowser } from "../../mcp/open-browser"
import { stringWidth } from "../markdown/width"
import { osc8Link, supportsHyperlinks } from "../markdown/hyperlink"
import {
  imagePlaceholderAt,
  listImageAttachments,
  pastedImagePaths,
  collapseImageRefs,
  expandComposerPastes,
} from "../input/image-attachments"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, type DOMElement } from "ink"

import { SlashPalette } from "./SlashPalette"
import { MentionPalette, orderByGroup } from "./MentionPalette"
import { useScreenReader } from "../render/context"
import { useTheme } from "../theme/context"
import { moveIndex } from "./select-list-state"
import { bufferFromText, bufferText, moveTo, onFirstLine, onLastLine } from "../input/buffer"
import { historyDown, historyUp } from "../input/history"
import { interpretKey, type KeyFlags } from "../input/keymap"
import { formatKeySpec } from "../input/keybindings"
import { parseMouseEvent } from "../input/mouse"
import { screenColToBufferCol } from "../input/mouse-cursor"
import { composerPopupRowAtClick } from "../input/composer-popup-click"
import { absoluteTopLeft } from "../input/element-position"
import { useComposerInput, useTuiInput, TUI_INPUT_PRIORITY } from "../input/input-router"
import { nextGraphemeBoundary } from "../text/graphemes"
import { composerViewport } from "../input/composer-viewport"
import { windowList } from "./list-window"
import { buildMentionView } from "./mention-view"
import { collapsePaste, PASTE_CHAR_THRESHOLD, type PasteResult } from "@/lib/paste-collapse"
import { useInlineSuggest } from "../input/inline-suggest"
import type { InlineCompleteFn } from "@/lib/chat/completion/inline/ai-provider"
import type { InlineCommandInfo } from "@/lib/chat/completion/inline/types"
import {
  enterNormalFromInsert,
  handleVimNormalKey,
  initialVimState,
  type VimMode,
} from "../input/vim"
import { matchSlash, slashQuery } from "../commands/matcher"
import { listVisibleCommands } from "../commands/registry"
import { buildCommandHint } from "../commands/command-hint"
import { type ListDir } from "../commands/file-completer"
import { activeBashPathToken, completeBashPath } from "../commands/bash-completer"
import { detectMention } from "../mention/detector"
import { acceptMention } from "../mention/accept"
import {
  highlightMentions,
  highlightMentionsWithCursor,
  type CursorLineSegment,
} from "../mention/highlight"
import { createMentionProviders, type MentionProviders } from "../mention/providers"
import { createMentionLoader } from "../mention/async-load"
import type { MentionCandidate } from "../mention/types"
import type { InputBuffer, InputEditOp, InputState, TuiAction } from "../state/types"

const PASTE_THRESHOLD = 4

/** Width of the per-line prompt gutter (`"› "` / `"  "`) before the text. */
const PROMPT_WIDTH = 2

/**
 * Decide whether an inserted chunk should collapse to a `[Pasted …]` placeholder.
 * A chunk collapses when it crosses EITHER the line-count threshold (the original
 * heuristic for terminals without bracketed paste) OR the character threshold (so
 * a single very long line pasted atomically via bracketed paste still collapses).
 * Pure so the routing is unit-testable without rendering Ink.
 */
export function routePasteInsert(
  chunk: string,
  id: number,
  lineThreshold = PASTE_THRESHOLD,
  charThreshold = PASTE_CHAR_THRESHOLD
): PasteResult {
  return collapsePaste(chunk, id, lineThreshold, charThreshold)
}

function makeFsListDir(cwd: string): ListDir {
  return (dir) => {
    try {
      return fs
        .readdirSync(path.resolve(cwd, dir), { withFileTypes: true })
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
    } catch {
      return []
    }
  }
}

/** Render one composer line: its mention tokens in their kind colour, plus the
 * inverse caret cell when the cursor is on this row. Cosmetic only, the buffer
 * itself is untouched. */
const LineView = React.memo(function LineView({
  line,
  cursorCol,
  disabled,
  logicalLine,
  start,
  pastes,
}: {
  line: string
  cursorCol: number
  disabled: boolean
  logicalLine: string
  start: number
  pastes: Record<string, string>
}) {
  const theme = useTheme()
  const screenReader = useScreenReader()
  // The caret is split INTO the mention segments rather than replacing them.
  // Rendering the cursor row as plain text instead made an `@agent:` token
  // change colour as the cursor moved onto and off its line.
  const segments = useMemo<CursorLineSegment[]>(
    () =>
      cursorCol < 0 || disabled || screenReader
        ? highlightMentions(line)
        : highlightMentionsWithCursor(line, cursorCol, nextGraphemeBoundary(line, cursorCol)),
    [line, cursorCol, disabled, screenReader]
  )
  const styled = useMemo(() => {
    let offset = start
    const result: Array<CursorLineSegment & { image?: string }> = []
    for (const segment of segments) {
      if (segment.atEnd) {
        result.push(segment)
        continue
      }
      const parts: Array<CursorLineSegment & { image?: string }> = []
      for (const char of segment.text) {
        const image = imagePlaceholderAt(logicalLine, offset, pastes)?.path
        const last = parts[parts.length - 1]
        if (last && last.image === image) last.text += char
        else parts.push({ ...segment, text: char, image })
        offset += char.length
      }
      result.push(...parts)
    }
    return result
  }, [segments, logicalLine, start, pastes])
  return (
    <Text>
      {styled.map((seg, i) => {
        // Two different carets. Over a character, invert the cell. Past the last
        // character, paint the block glyph itself: inverting a FULL BLOCK draws
        // it in the background colour across the whole cell, which is the same
        // as drawing nothing, and that is why the composer looked like it had
        // no cursor whenever the line was empty or the caret sat at the end.
        const atEndCaret = seg.cursor === true && seg.atEnd === true
        const onCharCaret = seg.cursor === true && !atEndCaret
        return (
          <Text
            key={i}
            color={
              atEndCaret
                ? theme.caret
                : ("image" in seg && seg.image) || seg.kind === "skill"
                  ? theme.accent
                  : seg.kind === "agent"
                    ? theme.info
                    : undefined
            }
            inverse={onCharCaret}
            underline={"image" in seg && Boolean(seg.image)}
          >
            {seg.image && supportsHyperlinks()
              ? osc8Link(pathToFileURL(seg.image).href, seg.text, true)
              : seg.text}
          </Text>
        )
      })}
    </Text>
  )
})

function InputImpl({
  input,
  dispatch,
  onSubmit,
  onHistoryPush,
  disabled = false,
  cwd,
  listDir: listDirProp,
  mentionProviders: mentionProvidersProp,
  width,
  popupRows,
  composerRows,
  keybindings,
  clipboardImageReady = false,
  mode,
  enabledSkillIds,
  onToggleSkill,
  onPopupOpenChange,
  placeholder,
  vimEnabled = false,
  localSuggestEnabled = true,
  aiComplete,
  agentComplete,
  suggestDebounceMs,
}: {
  input: InputState
  dispatch: (action: TuiAction) => void
  onSubmit: (text: string) => void
  /** Persist a submitted line to durable history (in addition to the in-memory
   * ring the reducer keeps). Optional — tests omit it. */
  onHistoryPush?: (entry: string) => void
  disabled?: boolean
  cwd: string
  listDir?: ListDir
  /** Skill/agent/file candidate sources for the `@` popup. Defaults to the real
   * disk/db providers; tests inject a stub. */
  mentionProviders?: MentionProviders
  /** Terminal columns so the composer + popups span the full width. */
  width?: number | string
  /** Row budget for the `@`/`/` popups so they stay compact above the composer. */
  popupRows?: number
  /** Maximum rendered text rows; the complete buffer remains editable. */
  composerRows?: number
  /** Resolved editor key bindings (line-home/end, word-delete). Optional — the
   * defaults are used when omitted. */
  keybindings?: Record<string, string>
  /** True while the OS clipboard holds an image — shows the paste-chord hint
   * under the composer. Driven by the App's clipboard poll; default off. */
  clipboardImageReady?: boolean
  /** Active permission mode — tints the composer border (loud warning for
   * `bypassPermissions`) so the dangerous mode is unmistakable. Optional. */
  mode?: string
  /** Session-enabled skill ids — annotates `@` skill rows with a ●/○ badge so the
   * popup shows what is already active. Live (updates after a Shift+Tab toggle). */
  enabledSkillIds?: Set<string>
  /** Toggle a skill's session-enabled state from the popup (Shift+Tab). The App
   * persists + invalidates the cached SendOptions and feeds the new set back via
   * {@link enabledSkillIds}. */
  onToggleSkill?: (id: string, enabled: boolean) => void
  /** Notify the parent when the `@`/`/` popup opens or closes, so the App can stop
   * routing the mouse wheel to the transcript while the popup owns it. */
  onPopupOpenChange?: (open: boolean) => void
  /** Dim hint shown on the empty first line until the user types. */
  placeholder?: string
  /** Vim editing mode (`/vim`): Esc drops to NORMAL, `i`/`a`/… re-enter INSERT.
   * See `input/vim.ts` for the supported motion/operator subset. */
  vimEnabled?: boolean
  /** Local (history + slash-command) inline completion. Default on. */
  localSuggestEnabled?: boolean
  /** Model-backed inline completion. Omit/null → local-only autosuggest. */
  aiComplete?: InlineCompleteFn | null
  /** Agent-turn completion, run only on the alt+\\ request. */
  agentComplete?: InlineCompleteFn | null
  /** Debounce before querying the model tier, ms. Clamped [200, 2000]. */
  suggestDebounceMs?: number
}) {
  const t = useCliTranslations("cliUiCommon")
  const theme = useTheme()
  const buffer = input.buffer
  const text = bufferText(buffer)
  const listDir = useMemo(() => listDirProp ?? makeFsListDir(cwd), [listDirProp, cwd])
  const mentionProviders = useMemo(
    () => mentionProvidersProp ?? createMentionProviders({ cwd, home: cwd, roots: [cwd] }),
    [mentionProvidersProp, cwd]
  )

  const [popupIndex, setPopupIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  // Vim mode: the modal state lives in a ref (mutated synchronously per key so
  // a same-tick burst like `dd` composes), mirrored into state for the render
  // of the mode indicator. `vimBufRef` tracks the latest buffer applied this
  // tick for the same reason — reducer updates land a render later.
  const [vimMode, setVimMode] = useState<VimMode>("insert")
  const vimStateRef = useRef(initialVimState())
  const vimBufRef = useRef(buffer)
  useEffect(() => {
    vimBufRef.current = buffer
  })
  // Async skill/agent candidates for the current `@` token, loaded in an effect.
  const [asyncCandidates, setAsyncCandidates] = useState<MentionCandidate[]>([])
  const [asyncLoading, setAsyncLoading] = useState(false)
  const pasteSeq = useRef(0)
  // Wraps the rendered buffer lines so a mouse click can be mapped to a cursor
  // position via the Yoga layout (see the click branch in the input handler).
  const linesRef = useRef<DOMElement | null>(null)
  // Wraps the `/`-palette / `@`-mention popup so a click on a row maps to the
  // candidate it lands on (select + accept), instead of falling through to the
  // buffer cursor logic below.
  const popupBoxRef = useRef<DOMElement | null>(null)
  const composerWidth = typeof width === "number" ? width : 80
  const viewport = useMemo(
    () =>
      composerViewport(
        buffer,
        Math.max(1, composerWidth - PROMPT_WIDTH - 4),
        composerRows ?? Number.MAX_SAFE_INTEGER
      ),
    [buffer, composerWidth, composerRows]
  )
  // Derive the active popup from the buffer.
  const cursorAtEnd =
    buffer.cursorRow === buffer.lines.length - 1 &&
    buffer.cursorCol === buffer.lines[buffer.cursorRow].length
  const sQuery = cursorAtEnd ? slashQuery(text) : null
  const slashMatches = sQuery !== null ? matchSlash(sQuery, { history: input.history.entries }) : []
  const beforeCursor = buffer.lines[buffer.cursorRow].slice(0, buffer.cursorCol)
  // Bash shell-out mode (`!command …`): complete file-path ARGUMENTS, reusing the
  // mention popup + accept pipeline with a synthetic `file` mention. `@`-mention
  // detection is suppressed here so the two popups never collide.
  const bashMode = text.startsWith("!")
  const bashTok = bashMode ? activeBashPathToken(beforeCursor) : null
  const detected: ReturnType<typeof detectMention> = bashMode
    ? bashTok
      ? { query: bashTok.token, start: bashTok.start, mode: "file" }
      : null
    : sQuery === null
      ? detectMention(beforeCursor)
      : null
  const mentionMode = detected?.mode
  const mentionQuery = detected?.query ?? ""
  const wantsFiles = mentionMode === "file" || mentionMode === "mixed"

  // Files compute synchronously; skills/agents arrive via the effect below. In
  // bash mode the candidates are bare paths (no `@`), from the bash completer.
  const fileCandidates = useMemo(
    () =>
      bashMode
        ? bashTok
          ? completeBashPath(bashTok.token, listDir)
          : []
        : wantsFiles
          ? mentionProviders.files(mentionQuery, listDir)
          : [],
    // Depend on `bashTok?.token` (the string), not the `bashTok` object, on
    // purpose: recompute only when the token text changes, not on every new
    // object identity. Listing `bashTok` would recompute needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bashMode, bashTok?.token, wantsFiles, mentionQuery, mentionProviders, listDir]
  )
  // Annotate skill rows with their live enabled state so the popup shows a ●/○
  // badge (and Shift+Tab can flip it). Files/agents pass through unchanged.
  const annotated = useMemo(
    () =>
      enabledSkillIds && enabledSkillIds.size > 0
        ? asyncCandidates.map((c) =>
            c.kind === "skill" ? { ...c, enabled: enabledSkillIds.has(c.id) } : c
          )
        : asyncCandidates,
    [asyncCandidates, enabledSkillIds]
  )
  const mentionCandidates = useMemo(
    () => orderByGroup([...fileCandidates, ...annotated]),
    [fileCandidates, annotated]
  )

  // Load skill/agent candidates whenever the `@` token (mode+query) changes.
  // The result lands via a promise (never a synchronous setState in the effect
  // body). When no skill/agent token is active the effect short-circuits: the
  // popup gates on `detected`, so any stale list is already hidden and need not
  // be cleared, and plain typing schedules no provider work.
  const wantSkills = mentionMode === "mixed" || mentionMode === "skill"
  const wantAgents = mentionMode === "mixed" || mentionMode === "agent"
  const mentionKey =
    detected && (wantSkills || wantAgents) ? `${mentionMode}:${mentionQuery}` : null

  // Debounced + stale-guarded loader over the providers. Memoised so its identity
  // is stable across keystrokes (only re-created if the providers change), and it
  // captures `mentionProviders` by value — no ref read during render.
  const mentionLoader = useMemo(
    () =>
      createMentionLoader(async (key: string) => {
        const sep = key.indexOf(":")
        const mode = key.slice(0, sep)
        const query = key.slice(sep + 1)
        const [skills, agents] = await Promise.all([
          mode === "mixed" || mode === "skill"
            ? mentionProviders.skills(query)
            : Promise.resolve([]),
          mode === "mixed" || mode === "agent"
            ? mentionProviders.agents(query)
            : Promise.resolve([]),
        ])
        return [...skills, ...agents]
      }),
    [mentionProviders]
  )

  // Kick off a (debounced) load whenever the `@` token changes. State updates only
  // happen inside the loader callback (loading flips true immediately, then the
  // candidates land), so the effect body itself calls no setState synchronously.
  // A stale `asyncLoading` when no token is active is masked by `mentionLoading`
  // below (gated on `mentionKey`), so the null branch needs no reset.
  useEffect(() => {
    if (mentionKey === null) {
      mentionLoader.cancel()
      return
    }
    mentionLoader.request(mentionKey, ({ loading, candidates }) => {
      setAsyncLoading(loading)
      if (loading) setAsyncCandidates([])
      else setAsyncCandidates(candidates)
    })
    return () => mentionLoader.cancel()
  }, [mentionKey, mentionLoader])

  // Loading only counts while a skill/agent token is actually active.
  const mentionLoading = mentionKey !== null && asyncLoading

  // The mention popup is shown only while an `@` token is under the cursor —
  // gating on `detected` (not just the candidate list) so a stale async result
  // can't keep the popup open after the token is accepted/cleared.
  const popupKind: "slash" | "mention" | "none" =
    slashMatches.length > 0
      ? "slash"
      : detected && (mentionCandidates.length > 0 || mentionLoading)
        ? "mention"
        : "none"
  const popupOpen = popupKind !== "none" && dismissed !== text
  // Tell the App whether a composer popup owns input right now, so it stops
  // routing the mouse wheel to the transcript while the `@`/`/` popup is open
  // (the wheel scrolls the popup instead — see the mouse branch below).
  useEffect(() => {
    onPopupOpenChange?.(popupOpen)
  }, [popupOpen, onPopupOpenChange])
  // Mode-aware wording for the in-flight affordance (`@skill:` vs bare `@`).
  const loadingLabel =
    mentionMode === "skill"
      ? "loading skills…"
      : mentionMode === "agent"
        ? "loading agents…"
        : "loading skills & agents…"
  // Inline usage hint for a partially-typed command (e.g. `/goal <objective …>`),
  // shown below the composer once a space follows a known command. Suppressed
  // while a popup is open so the two affordances never overlap.
  const commandHint = popupOpen || disabled ? null : buildCommandHint(text)
  const popupLen = popupKind === "slash" ? slashMatches.length : mentionCandidates.length
  const safeIndex = popupLen > 0 ? popupIndex % popupLen : 0
  // Visible-row cap for the popups — mirrors the components' own default so the
  // click hit-test windows the candidate list exactly as the render does.
  const POPUP_MAX_ROWS = popupRows ?? 8

  // Inline ghost-text autosuggest: a dim completion painted after the cursor,
  // ranked across command history, slash-command names, and (when configured)
  // a model continuation. Suppressed while a popup owns input (the palette
  // handles `/` and `@`), while the composer is disabled, when the cursor is
  // not at the very end, or on a multi-line draft — the ghost is rendered on
  // the cursor's row, so it must stay a single-row tail.
  //
  // `→` (or Tab) at the end of the draft accepts it; Alt+]/Alt+[ walk the
  // alternatives, matching the desktop composer's bindings.
  // A getter, not a snapshot: `registerCustomCommands` discovers project/user
  // commands from disk in a mount effect, and plugin commands register with
  // their plugin — both after this component's first render. A `useMemo([])`
  // froze the set at mount, so a user's own `/my-command` never appeared as
  // ghost text even though the `/` palette (which re-reads the registry every
  // open) listed it. Resolved at query time instead, which is at most once per
  // debounce rather than once per keystroke.
  const suggestCommands = useCallback(
    (): InlineCommandInfo[] =>
      listVisibleCommands().map((c) => ({
        name: c.name,
        description: c.description,
        aliases: c.aliases,
      })),
    []
  )
  const inline = useInlineSuggest({
    text,
    suppress: disabled || popupOpen || !cursorAtEnd || text.includes("\n"),
    history: input.history.entries,
    commands: suggestCommands,
    localEnabled: localSuggestEnabled,
    aiComplete: aiComplete ?? null,
    agentComplete: agentComplete ?? null,
    debounceMs: suggestDebounceMs,
    cwd,
  })
  const suggestion = inline.ghost.length > 0 ? inline.ghost : null
  // Tell the user WHERE the ghost came from: a history hit is exact and free,
  // a model hit is a guess that cost a call, and they look identical as dim
  // text. Adds the `n/total · alt+] cycles` affordance only when there is
  // actually somewhere to cycle to.
  const suggestionBadge = (() => {
    if (!inline.suggestion) return null
    const source = inline.suggestion.detail ?? inline.suggestion.source
    return inline.candidates.length > 1
      ? `${source} ${inline.index + 1}/${inline.candidates.length} · alt+] cycles`
      : source
  })()
  // The agent tier only runs when asked, so its key has to be visible at the
  // moment it is useful — which is when the free tiers found nothing and there
  // is no ghost to hang a badge off. Rendered independently of `suggestion`
  // for exactly that reason.
  const manualBadge = (() => {
    if (!inline.manualAvailable || !cursorAtEnd || disabled || popupOpen) return null
    if (inline.manualPending) return "asking the agent…"
    // Nothing to say once a suggestion is already showing its own badge, unless
    // the user might want a better one — which is always, so keep it short.
    return text.trim().length > 0 ? "alt+\\ agent" : null
  })()

  const setBuffer = (next: InputBuffer) => {
    setDismissed(null)
    dispatch({ type: "INPUT_SET", buffer: next })
  }

  // Per-keystroke edits go through the reducer (applied to the LIVE buffer) rather
  // than `setBuffer` (which carries a buffer precomputed from this render's
  // closure). When several keystrokes batch into one render — the norm once Ink
  // reads stdin directly — closure-computed edits all start from the same stale
  // buffer and only the last survives (the "only one letter types" bug); reducer
  // edits compose in order instead.
  const editBuffer = (edit: InputEditOp) => {
    setDismissed(null)
    dispatch({ type: "INPUT_EDIT", edit })
  }

  const doSubmit = () => {
    const raw = bufferText(buffer)
    if (raw.trim().length === 0) return
    const expanded = expandComposerPastes(raw, input.pastes).trim()
    dispatch({ type: "INPUT_PUSH_HISTORY", entry: expanded })
    onHistoryPush?.(expanded)
    onSubmit(expanded)
  }

  const acceptPopup = (idx: number = safeIndex) => {
    if (popupKind === "slash") {
      const cmd = slashMatches[idx]
      if (!cmd) return
      const line = `/${cmd.name}`
      if (cmd.subcommands?.length) {
        setPopupIndex(0)
        setBuffer(bufferFromText(`${line} `))
        return
      }
      dispatch({ type: "INPUT_PUSH_HISTORY", entry: line })
      onHistoryPush?.(line)
      dispatch({ type: "INPUT_CLEAR" })
      onSubmit(line)
      return
    }
    if (popupKind === "mention" && detected) {
      const candidate = mentionCandidates[idx]
      if (candidate) setBuffer(acceptMention(buffer, detected, candidate))
    }
  }

  // Shift+Tab on an open mention popup: flip the highlighted skill's enabled
  // state in place (●/○) without inserting it, so the user can curate which
  // skills are active straight from the `@` popup. No-op for files/agents.
  const togglePopupSkill = () => {
    if (popupKind !== "mention") return
    const candidate = mentionCandidates[safeIndex]
    if (candidate?.kind === "skill") onToggleSkill?.(candidate.id, !candidate.enabled)
  }

  // Tab on an open popup: complete the token in place without submitting. For
  // the slash palette this inserts `/<name> ` so the user can keep typing args
  // (Enter still submits). For mentions there's no submit/complete distinction,
  // so it behaves like accept.
  const completePopup = () => {
    if (popupKind === "slash") {
      const cmd = slashMatches[safeIndex]
      if (cmd) {
        setPopupIndex(0)
        setBuffer(bufferFromText(`/${cmd.name} `))
      }
      return
    }
    if (popupKind === "mention" && detected) {
      const candidate = mentionCandidates[safeIndex]
      if (candidate) setBuffer(acceptMention(buffer, detected, candidate))
    }
  }

  // Insert a chunk, collapsing it to a `[Pasted …]` placeholder when it's large.
  // Ink ≥7 coalesces a bracketed paste (mount.tsx enables `ESC[?2004h`) into a
  // SINGLE routed composer callback, so a multi-line/huge paste arrives here as one
  // `chunk` and `routePasteInsert` collapses it — no raw-stdin tee needed. (The
  // old `createPasteParser` + `stdin.on("data")` shim, required when older Ink
  // surfaced paste bodies char-by-char, attached a `data` listener that flipped
  // stdin into flowing mode and starved Ink's paused-mode `readable` reads —
  // silently killing ALL keyboard input, which looked like the composer losing
  // focus. Ink owns paste coalescing now, so the shim is gone.)
  const applyInsert = (chunk: string) => {
    const paths = !text.startsWith("!") && pastedImagePaths(chunk, cwd)
    if (paths) {
      dispatch({ type: "INPUT_ADD_IMAGES", paths })
      return
    }
    const r = routePasteInsert(chunk, pasteSeq.current)
    if (r.isLarge) {
      pasteSeq.current++
      dispatch({ type: "INPUT_ADD_PASTE", id: r.display, text: r.stored })
      editBuffer({ op: "insert", text: r.display })
    } else {
      editBuffer({ op: "insert", text: chunk })
    }
  }

  // The key handler, rebuilt each render so it closes over current state.
  const handleKey = (inputCh: string, key: KeyFlags) => {
    // Mouse reports leak in as plain text when SGR tracking is on (fullscreen
    // `scroll` mode). A left-click repositions the cursor where the user
    // clicked; every other mouse event is swallowed here so it never lands in
    // the buffer as literal `[<…M`. (The App separately routes the wheel to the
    // scroll viewport.)
    const mouse = parseMouseEvent(inputCh)
    if (mouse) {
      if (mouse.kind === "wheel" && popupOpen) {
        // The wheel scrolls the open popup (the App skips the transcript while
        // a popup owns input — see `onPopupOpenChange`). Up = previous row.
        setPopupIndex(moveIndex(safeIndex, mouse.dir === "up" ? -1 : 1, popupLen))
      } else if (mouse.kind === "click") {
        // A click on an open popup row selects + accepts it (parity with the
        // bordered overlay panels). Hit-test the popup first; only fall through
        // to buffer-cursor positioning when the click misses every row.
        if (popupOpen) {
          const popupPos = absoluteTopLeft(popupBoxRef.current)
          if (popupPos) {
            const picked =
              popupKind === "slash"
                ? (() => {
                    const win = windowList(slashMatches.length, safeIndex, POPUP_MAX_ROWS)
                    return composerPopupRowAtClick({
                      clickRow: mouse.row - 1,
                      popupTop: popupPos.top,
                      headerRows: 0,
                      hasAboveMore: win.above > 0,
                      hiddenAbove: win.start,
                      visibleCount: win.end - win.start,
                    })
                  })()
                : (() => {
                    const view = buildMentionView(mentionCandidates, safeIndex, POPUP_MAX_ROWS)
                    return composerPopupRowAtClick({
                      clickRow: mouse.row - 1,
                      popupTop: popupPos.top,
                      headerRows: 1,
                      hasAboveMore: false,
                      hiddenAbove: view.above,
                      visibleCount: view.rows.length,
                    })
                  })()
            if (picked !== null) {
              setPopupIndex(picked)
              acceptPopup(picked)
              return
            }
          }
        }
        const pos = absoluteTopLeft(linesRef.current)
        if (pos) {
          const visualRow = viewport.rows[mouse.row - 1 - pos.top]
          if (visualRow) {
            const screenCol = mouse.col - 1 - pos.left - PROMPT_WIDTH
            const col = visualRow.start + screenColToBufferCol(visualRow.text, screenCol)
            setBuffer(moveTo(buffer, visualRow.logicalRow, col))
          }
        }
      }
      return
    }
    // Vim mode (`/vim`): Esc drops INSERT to NORMAL; NORMAL keys run through the
    // pure interpreter in `input/vim.ts`. Popups keep their own key handling —
    // they only appear in INSERT (NORMAL never inserts trigger characters).
    if (vimEnabled) {
      if (vimStateRef.current.mode === "insert") {
        if (key.escape && !popupOpen) {
          vimStateRef.current = { ...vimStateRef.current, mode: "normal", pending: null, count: "" }
          setVimMode("normal")
          const next = enterNormalFromInsert(vimBufRef.current)
          vimBufRef.current = next
          setBuffer(next)
          return
        }
      } else {
        const r = handleVimNormalKey(inputCh, key, vimStateRef.current, vimBufRef.current)
        if (r.handled) {
          vimStateRef.current = r.state
          if (r.state.mode !== vimMode) setVimMode(r.state.mode)
          if (r.buffer !== vimBufRef.current) {
            vimBufRef.current = r.buffer
            setBuffer(r.buffer)
          }
          if (r.request === "undo") {
            setDismissed(null)
            dispatch({ type: "INPUT_UNDO" })
          } else if (r.request === "redo") {
            setDismissed(null)
            dispatch({ type: "INPUT_REDO" })
          } else if (r.request === "submit") {
            // A fresh prompt starts back in INSERT (Claude Code behaviour).
            vimStateRef.current = initialVimState()
            setVimMode("insert")
            doSubmit()
          }
          return
        }
        // handled: false → control chords fall through to the default flow.
      }
    }
    // Alt+\\ asks the agent tier for a continuation. Outside the `suggestion`
    // guard below on purpose: the tier exists to produce a suggestion when the
    // free ones had none, so requiring one first would make the key unreachable
    // exactly when it is wanted. Still gated on `cursorAtEnd` — a completion
    // only means anything at the end of the draft — and on the tier being
    // registered, so the keystroke falls through when it is switched off.
    if (inline.manualAvailable && cursorAtEnd && !disabled && key.meta && inputCh === "\\") {
      inline.requestManual()
      return
    }
    // Inline ghost-suggestion keys, handled before normal key interpretation.
    // Tab and `→` both accept: Tab is what the desktop composer uses (and
    // `interpretKey` maps it to `none` with no popup open, so it is free here),
    // while `→` at the end of the draft is a no-op move and was this surface's
    // original binding — keeping both makes the two composers muscle-memory
    // compatible without retraining anyone already using the arrow.
    // Alt+]/Alt+[ walk the ranked alternatives, same as the desktop.
    if (suggestion && cursorAtEnd) {
      if (key.rightArrow || (key.tab && !key.shift)) {
        const next = inline.accept()
        if (next !== null) {
          setBuffer(bufferFromText(next))
          return
        }
      }
      if (key.meta && inline.candidates.length > 1 && (inputCh === "]" || inputCh === "[")) {
        if (inputCh === "]") inline.cycleNext()
        else inline.cyclePrev()
        return
      }
    }
    const intent = interpretKey(
      inputCh,
      key,
      {
        popupOpen,
        onFirstLine: onFirstLine(buffer),
        onLastLine: onLastLine(buffer),
      },
      keybindings
    )
    switch (intent.type) {
      case "insert":
        applyInsert(intent.text)
        break
      case "newline":
        editBuffer({ op: "newline" })
        break
      case "backspace":
        editBuffer({ op: "backspace" })
        break
      case "delete-word":
        editBuffer({ op: "delete-word" })
        break
      case "kill-to-start":
        editBuffer({ op: "kill-to-start" })
        break
      case "kill-to-end":
        editBuffer({ op: "kill-to-end" })
        break
      case "undo":
        // Undo/redo are reducer-owned (the undo stack lives in input state), so
        // dispatch directly rather than routing through setBuffer.
        setDismissed(null)
        dispatch({ type: "INPUT_UNDO" })
        break
      case "redo":
        setDismissed(null)
        dispatch({ type: "INPUT_REDO" })
        break
      case "move":
        editBuffer({ op: "move", dir: intent.dir })
        break
      case "history": {
        const r = intent.dir === "up" ? historyUp(input.history, text) : historyDown(input.history)
        dispatch({ type: "INPUT_HISTORY", history: r.history })
        const recalled = collapseImageRefs(r.text, input.pastes)
        for (const [id, text] of Object.entries(recalled.pastes)) {
          dispatch({ type: "INPUT_ADD_PASTE", id, text })
        }
        dispatch({ type: "INPUT_SET", buffer: bufferFromText(recalled.text) })
        // Suppress the slash/mention palette for the recalled entry. A bare
        // `/cmd` or `@skill` history line would otherwise re-open the popup,
        // which unconditionally captures ↑/↓ (see keymap) and strands the user
        // mid-cycle — unable to keep stepping through history. Marking the
        // recalled text dismissed keeps `popupOpen` false until the user edits
        // it (setBuffer clears `dismissed`), at which point completion resumes.
        setDismissed(recalled.text)
        break
      }
      case "submit":
        doSubmit()
        break
      case "popup-move":
        setPopupIndex(moveIndex(safeIndex, intent.delta, popupLen))
        break
      case "popup-accept":
        acceptPopup()
        break
      case "popup-complete":
        completePopup()
        break
      case "popup-toggle":
        togglePopupSkill()
        break
      case "popup-cancel":
        if (popupKind === "slash" && sQuery !== null && /\s/.test(sQuery)) {
          setPopupIndex(0)
          setBuffer(bufferFromText(`/${sQuery.split(/\s+/)[0]}`))
        } else setDismissed(text)
        break
      default:
        break
    }
  }
  // Latest-ref wrapper. The input router registers this callback once and is meant to
  // invoke the freshest closure each keypress, but under our tsx/CJS bundle that
  // capture doesn't refresh reliably — the handler strands on an early render and
  // every closure read goes stale: `doSubmit` saw an empty buffer (Enter never
  // sent) and the popup keys saw `popupOpen=false` (Tab did nothing, ↑/↓ fell
  // through to history) even with the palette on screen. Updating the ref in an
  // effect after every commit and calling it through a stable wrapper guarantees
  // the handler always runs against current state. (Text edits also go through
  // INPUT_EDIT so they survive even a same-tick burst, which no ref can cover.)
  const onKeyRef = useRef(handleKey)
  useEffect(() => {
    onKeyRef.current = handleKey
  })
  // Only attachment hits outrank transcript mouse handling. Coordinates use the
  // same wrapped rows and prompt gutter as the visible composer, not raw paths.
  useTuiInput(
    (chunk) => {
      const mouse = parseMouseEvent(chunk)
      if (mouse?.kind !== "click") return false
      const pos = absoluteTopLeft(linesRef.current)
      if (!pos) return false
      const row = viewport.rows[mouse.row - 1 - pos.top]
      const column = mouse.col - 1 - pos.left - PROMPT_WIDTH
      if (!row || column < 0 || column >= composerWidth - PROMPT_WIDTH - 4) return false
      const col = row.start + screenColToBufferCol(row.text, column)
      const image = imagePlaceholderAt(buffer.lines[row.logicalRow], col, input.pastes)
      if (!image) return false
      const imageLeft = stringWidth(row.text.slice(0, Math.max(0, image.start - row.start)))
      const imageRight = stringWidth(
        row.text.slice(0, Math.min(row.text.length, image.end - row.start))
      )
      if (column < imageLeft || column >= imageRight) return false
      void openBrowser(pathToFileURL(image.path).href)
      return true
    },
    { priority: TUI_INPUT_PRIORITY.global + 1, isActive: !disabled }
  )

  useComposerInput((inputCh, key) => onKeyRef.current(inputCh, key), {
    isActive: !disabled,
    popupOpen,
  })

  // Command mode: the first char of the draft selects a distinct submit path —
  // `!` shells out, `/` runs a slash command. Recoloring the whole composer makes
  // the active mode unmistakable (vs. a plain message to the model). Derived from
  // the live buffer so it tracks every keystroke. `bash` only counts as command
  // mode once there's a command after the `!` is not required — the bare `!` is
  // already the signal.
  const commandMode: "bash" | "slash" | null = text.startsWith("!")
    ? "bash"
    : text.startsWith("/")
      ? "slash"
      : null
  // Mode-aware composer border: loud warning while `bypassPermissions` is active
  // (so the dangerous mode is unmistakable), then the command-mode accents
  // (shell = secondary, slash = info), subtle while disabled, normal otherwise.
  // The empty-state placeholder shows until the user types and is suppressed
  // while a turn is in flight or a popup is open.
  const composerBorder = disabled
    ? theme.borderSubtle
    : mode === "bypassPermissions"
      ? theme.warning
      : commandMode === "bash"
        ? theme.secondary
        : commandMode === "slash"
          ? theme.info
          : theme.border
  // The prompt glyph echoes the mode so the gutter itself signals command mode.
  const promptColor = disabled
    ? theme.muted
    : commandMode === "bash"
      ? theme.secondary
      : commandMode === "slash"
        ? theme.info
        : theme.userPrompt
  // Obvious one-line hint under the composer for shell mode (slash mode already
  // shows the palette + `commandHint`). Suppressed while a popup is open.
  const modeHint =
    !disabled && !popupOpen && commandMode === "bash"
      ? "shell mode · Enter runs this in your shell"
      : !disabled && vimEnabled && vimMode === "normal"
        ? "-- NORMAL -- · i insert · dd/cw edit · Enter send"
        : null
  const showPlaceholder = !disabled && !popupOpen && text.length === 0
  // Live attachment count — labels that resolve through the paste map to an
  // image. Drives the "N attached · /images to manage" hint; the panel itself
  // opens via the `/images` command or the attachments keybinding.
  const attachmentCount = useMemo(
    () => listImageAttachments(buffer.lines, input.pastes).length,
    [buffer.lines, input.pastes]
  )
  // Advertise the configured paste chord, not a hardcoded Ctrl+V — a rebind via
  // `/keybind` shows up here.
  const attachmentsHint =
    !disabled && !popupOpen && (clipboardImageReady || attachmentCount > 0)
      ? [
          clipboardImageReady
            ? t("clipboardImageReady", { key: formatKeySpec(keybindings?.pasteImage ?? "ctrl+v") })
            : null,
          attachmentCount > 0 ? t("imagesAttached", { count: attachmentCount }) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box flexDirection="column" ref={popupBoxRef}>
        {popupOpen && popupKind === "slash" && (
          <SlashPalette
            matches={slashMatches}
            index={safeIndex}
            query={sQuery ?? ""}
            maxRows={popupRows}
            width={width}
          />
        )}
        {popupOpen && popupKind === "mention" && (
          <MentionPalette
            candidates={mentionCandidates}
            index={safeIndex}
            maxRows={popupRows}
            width={width}
            loading={mentionLoading}
            loadingLabel={loadingLabel}
          />
        )}
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={composerBorder}
        paddingX={1}
        width={width}
      >
        <Box flexDirection="column" ref={linesRef}>
          {viewport.rows.map((visualRow) => (
            <Box key={`${visualRow.logicalRow}:${visualRow.start}`}>
              <Text color={promptColor}>
                {visualRow.logicalRow === 0 && !visualRow.continuation ? "› " : "  "}
              </Text>
              <LineView
                line={visualRow.text}
                logicalLine={buffer.lines[visualRow.logicalRow]}
                start={visualRow.start}
                pastes={input.pastes}
                cursorCol={visualRow.cursorCol ?? -1}
                disabled={disabled}
              />
              {visualRow.logicalRow === 0 && !visualRow.continuation && showPlaceholder && (
                <Text color={theme.muted} dimColor>
                  {placeholder ?? t("composerPlaceholder")}
                </Text>
              )}
              {visualRow.cursorCol !== null && cursorAtEnd && suggestion && (
                <>
                  <Text color={theme.muted} dimColor>
                    {suggestion}
                  </Text>
                  {suggestionBadge ? (
                    <Text color={theme.muted} dimColor>
                      {"  "}
                      {suggestionBadge}
                    </Text>
                  ) : null}
                </>
              )}
              {visualRow.cursorCol !== null && cursorAtEnd && manualBadge ? (
                <Text color={theme.muted} dimColor>
                  {"  "}
                  {manualBadge}
                </Text>
              ) : null}
            </Box>
          ))}
        </Box>
      </Box>
      {modeHint ? (
        <Text color={theme.secondary}>
          {"  "}
          {modeHint}
        </Text>
      ) : commandHint ? (
        <Text color={theme.muted} dimColor>
          {"  "}
          {commandHint}
        </Text>
      ) : null}
      {attachmentsHint ? (
        <Text color={theme.muted} dimColor>
          {"  "}
          {attachmentsHint}
        </Text>
      ) : null}
    </Box>
  )
}

/**
 * Memoized so the composer doesn't re-render (and re-run slash/mention matching)
 * on every streaming delta while it sits idle below the transcript. The parent
 * must keep callback props (`onSubmit`, `onHistoryPush`, `onPopupOpenChange`,
 * `onToggleSkill`) reference-stable for the memo to skip — see App.tsx.
 */
export const Input = React.memo(InputImpl)
