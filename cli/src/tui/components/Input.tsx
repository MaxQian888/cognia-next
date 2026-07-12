/**
 * The composer: a multiline editor with command history, a `/` command palette,
 * `@` file-path completion, and large-paste collapsing. All editing/keymap logic
 * is pure (`input/*`, `commands/*`); this component wires those to Ink's
 * `useInput` and the reducer's input state, and renders the buffer + popups.
 *
 * Global keys (Ctrl+C exit, Esc-while-busy interrupt) are owned by the App; this
 * handler treats `exit`/`interrupt` intents as no-ops.
 */
import fs from "node:fs"
import path from "node:path"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useInput, type DOMElement } from "ink"

import { SlashPalette } from "./SlashPalette"
import { MentionPalette, orderByGroup } from "./MentionPalette"
import { useTheme } from "../theme/context"
import { moveIndex } from "./select-list-state"
import { bufferFromText, bufferText, moveTo, onFirstLine, onLastLine } from "../input/buffer"
import { historyDown, historyUp } from "../input/history"
import { interpretKey, type KeyFlags } from "../input/keymap"
import { parseMouseEvent } from "../input/mouse"
import { clickToCursor } from "../input/mouse-cursor"
import { composerPopupRowAtClick } from "../input/composer-popup-click"
import { absoluteTopLeft } from "../input/element-position"
import { windowList } from "./list-window"
import { buildMentionView } from "./mention-view"
import {
  collapsePaste,
  expandPastes,
  PASTE_CHAR_THRESHOLD,
  type PasteResult,
} from "@/lib/paste-collapse"
import { suggest } from "../input/autosuggest"
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
import { highlightMentions } from "../mention/highlight"
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

/** Render a line's mention tokens in their kind colour (cosmetic only). Used
 * when the cursor is not on this row, so we never have to splice the inverse
 * cursor cell into a coloured segment. */
const HighlightedLine = React.memo(function HighlightedLine({ line }: { line: string }) {
  const theme = useTheme()
  const segments = useMemo(() => highlightMentions(line), [line])
  return (
    <Text>
      {segments.map((seg, i) => {
        const color =
          seg.kind === "skill" ? theme.accent : seg.kind === "agent" ? theme.info : undefined
        return (
          <Text key={i} color={color}>
            {seg.text}
          </Text>
        )
      })}
    </Text>
  )
})

const LineView = React.memo(function LineView({
  line,
  cursorCol,
  disabled,
}: {
  line: string
  cursorCol: number
  disabled: boolean
}) {
  // No cursor on this row → render with mention-token highlighting.
  if (cursorCol < 0 || disabled) return <HighlightedLine line={line} />
  const before = line.slice(0, cursorCol)
  const at = line.slice(cursorCol, cursorCol + 1) || " "
  const after = line.slice(cursorCol + 1)
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
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
  keybindings,
  mode,
  enabledSkillIds,
  onToggleSkill,
  onPopupOpenChange,
  placeholder = "Ask, run /commands, @ files, or ! shell",
  vimEnabled = false,
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
  /** Resolved editor key bindings (line-home/end, word-delete). Optional — the
   * defaults are used when omitted. */
  keybindings?: Record<string, string>
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
}) {
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

  // Derive the active popup from the buffer.
  const sQuery = slashQuery(text)
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

  // Inline ghost-text autosuggest: a dim completion shown after the cursor when
  // the single-line draft is a prefix of a prior history entry (or slash name).
  // Suppressed while a popup owns input (the palette handles `/` and `@`) or the
  // composer is disabled. `→` at the end of the draft accepts it.
  const cursorAtEnd =
    buffer.cursorRow === buffer.lines.length - 1 &&
    buffer.cursorCol === buffer.lines[buffer.cursorRow].length
  const suggestion =
    disabled || popupOpen
      ? null
      : suggest(text, cursorAtEnd, {
          history: [...input.history.entries].reverse(),
          commands: listVisibleCommands().map((c) => `/${c.name}`),
        })

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
    const expanded = expandPastes(raw, input.pastes).trim()
    dispatch({ type: "INPUT_PUSH_HISTORY", entry: raw })
    onHistoryPush?.(raw)
    onSubmit(expanded)
  }

  const acceptPopup = (idx: number = safeIndex) => {
    if (popupKind === "slash") {
      const cmd = slashMatches[idx]
      if (!cmd) return
      const line = `/${cmd.name}`
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
      if (cmd) setBuffer(bufferFromText(`/${cmd.name} `))
      return
    }
    if (popupKind === "mention" && detected) {
      const candidate = mentionCandidates[safeIndex]
      if (candidate) setBuffer(acceptMention(buffer, detected, candidate))
    }
  }

  // Insert a chunk, collapsing it to a `[Pasted …]` placeholder when it's large.
  // Ink ≥7 coalesces a bracketed paste (mount.tsx enables `ESC[?2004h`) into a
  // SINGLE `useInput` callback, so a multi-line/huge paste arrives here as one
  // `chunk` and `routePasteInsert` collapses it — no raw-stdin tee needed. (The
  // old `createPasteParser` + `stdin.on("data")` shim, required when older Ink
  // surfaced paste bodies char-by-char, attached a `data` listener that flipped
  // stdin into flowing mode and starved Ink's paused-mode `readable` reads —
  // silently killing ALL keyboard input, which looked like the composer losing
  // focus. Ink owns paste coalescing now, so the shim is gone.)
  const applyInsert = (chunk: string) => {
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
          const target = clickToCursor({
            clickRow: mouse.row - 1,
            clickCol: mouse.col - 1,
            boxTop: pos.top,
            boxLeft: pos.left,
            lines: buffer.lines,
            promptWidth: PROMPT_WIDTH,
          })
          if (target) setBuffer(moveTo(buffer, target.row, target.col))
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
    // Accept an inline ghost suggestion: → at the very end of the draft fills
    // it in (a no-op move otherwise), before normal key interpretation.
    if (suggestion && key.rightArrow && cursorAtEnd) {
      setBuffer(bufferFromText(text + suggestion))
      return
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
        dispatch({ type: "INPUT_SET", buffer: bufferFromText(r.text) })
        // Suppress the slash/mention palette for the recalled entry. A bare
        // `/cmd` or `@skill` history line would otherwise re-open the popup,
        // which unconditionally captures ↑/↓ (see keymap) and strands the user
        // mid-cycle — unable to keep stepping through history. Marking the
        // recalled text dismissed keeps `popupOpen` false until the user edits
        // it (setBuffer clears `dismissed`), at which point completion resumes.
        setDismissed(r.text)
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
        setDismissed(text)
        break
      default:
        break
    }
  }
  // Latest-ref wrapper. Ink registers the `useInput` callback once and is meant to
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
  useInput((inputCh, key) => onKeyRef.current(inputCh, key), { isActive: !disabled })

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

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box flexDirection="column" ref={popupBoxRef}>
        {popupOpen && popupKind === "slash" && (
          <SlashPalette
            matches={slashMatches}
            index={safeIndex}
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
          {buffer.lines.map((line, row) => (
            <Box key={row}>
              <Text color={promptColor}>{row === 0 ? "› " : "  "}</Text>
              <LineView
                line={line}
                cursorCol={row === buffer.cursorRow ? buffer.cursorCol : -1}
                disabled={disabled}
              />
              {row === 0 && showPlaceholder && (
                <Text color={theme.muted} dimColor>
                  {placeholder}
                </Text>
              )}
              {row === buffer.cursorRow && cursorAtEnd && suggestion && (
                <Text color={theme.muted} dimColor>
                  {suggestion}
                </Text>
              )}
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
