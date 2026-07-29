"use client"

/**
 * Root of the selection-toolbar overlay window.
 *
 * Owns the candidate subscription, the IPC, and the phase machine the capsule
 * renders. Six actions collapse into three feedback shapes:
 *
 *   copy                      → run in Rust, show ✓, leave
 *   explain / translate / ask → hand to the main window, which comes forward;
 *                               leave immediately, the user is looking there
 *   remember / speak          → hand over *without* stealing focus and stay
 *                               put, waiting for a result or driving a player
 *
 * The third shape is why the toolbar can be held open at all: the memory PII
 * gate returns `{ok:false}` rather than throwing, so dismissing optimistically
 * would make a blocked write vanish silently whenever the main window sits in
 * the tray.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, useReducedMotion } from "motion/react"
import { emitTo, listen } from "@tauri-apps/api/event"
import { useLocale, useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { getPref, setPref } from "@/lib/tauri/store"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { isTauri } from "@/lib/tauri"
import { isMacPlatform } from "@/lib/tauri/os"
import {
  executeSelectionToolbarAction,
  finishSelectionToolbar,
  getCurrentSelectionCandidate,
  listShortcutChords,
  revealSelectionToolbar,
  SELECTION_CANDIDATE_EVENT,
  SELECTION_DISMISS_EVENT,
  SELECTION_ESCAPE_EVENT,
  SELECTION_RESULT_EVENT,
  SELECTION_SHADOW_PAD,
  SELECTION_SHORTCUT_EVENT,
  SELECTION_SPEECH_EVENT,
  SELECTION_SPEECH_STOP_EVENT,
  setSelectionToolbarInteractive,
  setSelectionToolbarKeepAlive,
  type ExternalSelectionCandidate,
  type SelectionResultPayload,
  type SelectionShortcutPayload,
  type SelectionSpeechPayload,
  type SelectionToolbarAction,
} from "@/lib/tauri/selection-toolbar"
import { classifySelection, type SelectionClassification } from "@/lib/selection/classify-selection"
import {
  defaultSearchEngine,
  isSearchEngineId,
  SELECTION_SEARCH_ENGINE_PREF,
} from "@/lib/selection/search-engines"
import {
  findAction,
  findActionByShortcutId,
  initialTargetLocale,
  resolveVisibleActions,
  SELECTION_CONTEXTUAL_ACTIONS_PREF,
  SELECTION_TRANSLATE_LOCALE_PREF,
  TARGET_LOCALES,
  type SelectionActionId,
  type TargetLocale,
} from "./selection-toolbar-actions"
import { SelectionToolbarCapsule, type SelectionToolbarPhase } from "./selection-toolbar-capsule"
import { useSelectionToolbarGeometry } from "./use-selection-toolbar-geometry"

/** How long a ✓ stays up before the toolbar leaves. */
const SUCCESS_DWELL_MS = 420
/** How long an error stays up. Longer — it has to be read, not just noticed. */
const ERROR_DWELL_MS = 6_000

const MAIN_WINDOW_LABEL = "main"

/**
 * Build the wire action for a button press.
 *
 * The contextual actions carry a payload the classifier already computed, so
 * Rust does not have to re-derive "which part of this text was the link".
 * Returns `null` when the classification that made a button visible is somehow
 * absent by the time it is pressed — better to do nothing than to guess a URL.
 */
function toAction(
  id: SelectionActionId,
  targetLocale: TargetLocale,
  classification: SelectionClassification,
  searchEngine: string
): SelectionToolbarAction | null {
  switch (id) {
    case "translate":
      return { kind: "translate", targetLocale }
    case "openLink":
      return classification.url ? { kind: "openLink", url: classification.url } : null
    case "composeEmail":
      return classification.email ? { kind: "composeEmail", address: classification.email } : null
    case "searchWeb":
      return { kind: "searchWeb", engine: searchEngine }
    default:
      return { kind: id }
  }
}

export function SelectionToolbarView() {
  const t = useTranslations("selectionToolbar")
  const locale = useLocale()
  const reduceMotion = useReducedMotion() ?? false

  const [candidate, setCandidate] = useState<ExternalSelectionCandidate | null>(null)
  const [phase, setPhase] = useState<SelectionToolbarPhase>({ kind: "idle" })
  const [hovered, setHovered] = useState<SelectionActionId | null>(null)
  const [localeOpen, setLocaleOpen] = useState(false)
  const [chords, setChords] = useState<Record<string, string>>({})
  const [targetLocale, setTargetLocale] = useState<TargetLocale>(() => initialTargetLocale(locale))
  const [contextualEnabled, setContextualEnabled] = useState(true)
  const [searchEngine, setSearchEngine] = useState(() => defaultSearchEngine(locale))
  const isMac = useMemo(() => isMacPlatform(), [])

  // Pure and synchronous, so the buttons a selection deserves are known on the
  // same render the candidate arrives — there is never a frame where the
  // capsule shows the wrong set.
  const classification = useMemo(
    () => classifySelection(candidate?.text ?? "", { uiLocale: locale }),
    [candidate?.text, locale]
  )
  const visibleActions = useMemo(
    () =>
      resolveVisibleActions({
        types: classification.types,
        candidate: {
          origin: candidate?.origin,
          sourceSubrole: candidate?.sourceSubrole,
        },
        contextualEnabled,
      }),
    [classification.types, candidate?.origin, candidate?.sourceSubrole, contextualEnabled]
  )

  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearDwell = useCallback(() => {
    if (dwellRef.current) {
      clearTimeout(dwellRef.current)
      dwellRef.current = null
    }
  }, [])

  // Any layout-affecting input. `useSelectionToolbarGeometry` re-measures on
  // every change and pushes the result to Rust.
  const contentKey = [
    candidate?.id ?? "none",
    phase.kind,
    phase.kind === "pending" || phase.kind === "ok" || phase.kind === "error" ? phase.action : "",
    phase.kind === "speaking" && phase.progress !== undefined ? "p" : "",
    hovered ?? "",
    localeOpen ? "menu" : "",
    targetLocale,
    candidate?.truncated ? "trunc" : "",
    Object.keys(chords).length,
  ].join("|")
  const geometry = useSelectionToolbarGeometry(contentKey)

  useEffect(() => {
    if (!isTauri()) return
    document.documentElement.setAttribute("data-selection-toolbar", "true")
    let alive = true
    const unlistens: Array<() => void | Promise<void>> = []
    const track = (unlisten: () => void) => {
      if (alive) unlistens.push(unlisten)
      else safeUnlisten(unlisten)
    }

    void Promise.all([
      getCurrentSelectionCandidate().then((current) => {
        if (alive) setCandidate(current)
      }),
      listShortcutChords().then((bound) => {
        if (alive) setChords(bound)
      }),
      getPref<string>(SELECTION_TRANSLATE_LOCALE_PREF).then((saved) => {
        if (alive && TARGET_LOCALES.includes(saved as TargetLocale)) {
          setTargetLocale(saved as TargetLocale)
        }
      }),
      // Both default on / locale-derived, so an unset pref is not an error —
      // only an explicit `false` or a recognized engine id changes anything.
      getPref<boolean>(SELECTION_CONTEXTUAL_ACTIONS_PREF).then((saved) => {
        if (alive && saved === false) setContextualEnabled(false)
      }),
      getPref<string>(SELECTION_SEARCH_ENGINE_PREF).then((saved) => {
        if (alive && isSearchEngineId(saved)) setSearchEngine(saved)
      }),
      listen<ExternalSelectionCandidate>(SELECTION_CANDIDATE_EVENT, (event) => {
        if (!alive) return
        clearDwell()
        setCandidate(event.payload)
        setPhase({ kind: "idle" })
        setHovered(null)
        setLocaleOpen(false)
      }).then(track),
      listen(SELECTION_ESCAPE_EVENT, () => {
        // Rust only routes Escape here while a sub-panel owns focus; closing it
        // hands Escape back, so a second press dismisses the toolbar.
        if (alive) setLocaleOpen(false)
      }).then(track),
      listen(SELECTION_DISMISS_EVENT, () => {
        if (!alive) return
        clearDwell()
        // Unmounting drives the AnimatePresence exit; Rust holds the native
        // hide back by EXIT_ANIMATION_MS for idle/completed dismissals so the
        // animation is actually on screen.
        setCandidate(null)
        setPhase({ kind: "idle" })
        setHovered(null)
        setLocaleOpen(false)
      }).then(track),
    ])

    return () => {
      alive = false
      document.documentElement.removeAttribute("data-selection-toolbar")
      unlistens.forEach(safeUnlisten)
    }
  }, [clearDwell])

  // Reveal only once the window has been sized to its content. Replaces a
  // double-rAF guess, and on Windows the resize doubles as the recomposite
  // nudge a `transparent(true)` window needs to avoid painting black
  // (see `lib/pet/reveal.ts` for the same quirk on the pet windows).
  const measured = geometry.measured
  useEffect(() => {
    if (!candidate || !measured) return
    void revealSelectionToolbar()
  }, [candidate, measured])

  // Freeze the idle countdown whenever the user is engaged with the toolbar or
  // something is still in flight.
  const busy = phase.kind !== "idle"
  useEffect(() => {
    if (!candidate) return
    void setSelectionToolbarKeepAlive(hovered !== null || localeOpen || busy)
  }, [candidate, hovered, localeOpen, busy])

  useEffect(() => {
    if (!candidate) return
    void setSelectionToolbarInteractive(localeOpen)
  }, [candidate, localeOpen])

  const finish = useCallback((candidateId: string) => {
    void finishSelectionToolbar(candidateId)
  }, [])

  const runAction = useCallback(
    (id: SelectionActionId) => {
      if (!candidate) return
      const descriptor = findAction(id)
      if (!descriptor || phase.kind === "pending") return
      const action = toAction(id, targetLocale, classification, searchEngine)
      // The classification that made a contextual button visible has gone
      // missing. Doing nothing beats guessing a URL to open.
      if (!action) return
      setLocaleOpen(false)
      clearDwell()

      if (descriptor.mode === "handoff" || descriptor.mode === "launch") {
        // Rust dismisses both itself: `handoff` once the main window has the
        // payload, `launch` once it has handed off to the browser or mail
        // client. Either way the user's attention has already moved.
        void executeSelectionToolbarAction(candidate.id, action)
        return
      }

      setPhase({ kind: "pending", action: id })
      void executeSelectionToolbarAction(candidate.id, action)
        .then(() => {
          if (descriptor.mode !== "local") return
          // Copy completes inside Rust, so there is nothing to wait for — show
          // the checkmark, then leave.
          setPhase({ kind: "ok", action: id })
          dwellRef.current = setTimeout(() => finish(candidate.id), SUCCESS_DWELL_MS)
        })
        .catch(() => {
          setPhase({ kind: "error", action: id, reason: t("errors.generic") })
          dwellRef.current = setTimeout(() => finish(candidate.id), ERROR_DWELL_MS)
        })
    },
    [candidate, phase.kind, targetLocale, classification, searchEngine, clearDwell, finish, t]
  )

  // Results and playback state arrive from the main window, which owns the
  // memory writer and the single `ttsOrchestrator` shared with chat and the pet.
  useEffect(() => {
    if (!isTauri() || !candidate) return
    let alive = true
    const unlistens: Array<() => void | Promise<void>> = []
    const track = (unlisten: () => void) => {
      if (alive) unlistens.push(unlisten)
      else safeUnlisten(unlisten)
    }

    void Promise.all([
      listen<SelectionResultPayload>(SELECTION_RESULT_EVENT, (event) => {
        if (!alive || event.payload.candidateId !== candidate.id) return
        clearDwell()
        if (event.payload.ok) {
          setPhase({ kind: "ok", action: "remember" })
          dwellRef.current = setTimeout(() => finish(candidate.id), SUCCESS_DWELL_MS)
          return
        }
        const reason =
          event.payload.reason === "pii_blocked" ? t("errors.piiBlocked") : t("errors.generic")
        setPhase({ kind: "error", action: "remember", reason })
        dwellRef.current = setTimeout(() => finish(candidate.id), ERROR_DWELL_MS)
      }).then(track),
      listen<SelectionSpeechPayload>(SELECTION_SPEECH_EVENT, (event) => {
        if (!alive || event.payload.candidateId !== candidate.id) return
        if (event.payload.playing) {
          setPhase({ kind: "speaking", progress: event.payload.progress })
          return
        }
        clearDwell()
        finish(candidate.id)
      }).then(track),
      listen<SelectionShortcutPayload>(SELECTION_SHORTCUT_EVENT, (event) => {
        if (!alive || event.payload.candidateId !== candidate.id) return
        const descriptor = findActionByShortcutId(event.payload.shortcutId)
        if (descriptor) runAction(descriptor.id)
      }).then(track),
    ])

    return () => {
      alive = false
      unlistens.forEach(safeUnlisten)
    }
  }, [candidate, clearDwell, finish, runAction, t])

  useEffect(() => clearDwell, [clearDwell])

  const chooseTarget = useCallback(
    (next: TargetLocale) => {
      setTargetLocale(next)
      setLocaleOpen(false)
      void setPref(SELECTION_TRANSLATE_LOCALE_PREF, next)
      if (!candidate) return
      void executeSelectionToolbarAction(candidate.id, { kind: "translate", targetLocale: next })
    },
    [candidate]
  )

  const stopSpeech = useCallback(() => {
    if (!candidate) return
    void emitTo(MAIN_WINDOW_LABEL, SELECTION_SPEECH_STOP_EVENT, { candidateId: candidate.id })
  }, [candidate])

  return (
    <div
      className={cn(
        "flex h-screen w-screen select-none justify-center",
        // Rust pins the window edge nearest the selection: placing above fixes
        // the window's BOTTOM (`y = anchor.y - height - margin`), placing below
        // fixes its TOP. Anchoring the content to that same edge is what keeps
        // the capsule still while the window grows for the language panel —
        // the old code grew from a re-anchored top edge and teleported it.
        geometry.placement === "above" ? "items-end" : "items-start"
      )}
      style={{ padding: SELECTION_SHADOW_PAD }}
      data-testid="selection-toolbar"
      title={
        candidate
          ? candidate.sourceTitle
            ? `${candidate.sourceApp} · ${candidate.sourceTitle}`
            : candidate.sourceApp
          : undefined
      }
    >
      <AnimatePresence>
        {candidate ? (
          <SelectionToolbarCapsule
            key={candidate.id}
            geometry={geometry}
            actions={visibleActions}
            phase={phase}
            hovered={hovered}
            onHoverChange={setHovered}
            onAction={runAction}
            onStopSpeech={stopSpeech}
            chords={chords}
            isMac={isMac}
            targetLocale={targetLocale}
            localeOpen={localeOpen}
            onLocaleOpenChange={setLocaleOpen}
            onLocaleSelect={chooseTarget}
            truncated={candidate.truncated}
            reduceMotion={reduceMotion}
          />
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default SelectionToolbarView
