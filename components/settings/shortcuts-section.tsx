"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { KeyboardIcon, RotateCcwIcon } from "lucide-react"
import { isTauri } from "@/lib/tauri"
import { Button } from "@/components/ui/button"
import { useShortcutStore } from "@/lib/shortcuts/registry"
import { parseKeyEvent, formatKeybinding } from "@/lib/shortcuts/utils"
import type { Chord } from "@/lib/shortcuts/types"
import { useTrayStore } from "@/lib/tray/store"
import type { TrayMenuItem } from "@/lib/tray/types"

/**
 * Defaults shipped with the bootstrap shortcut registry — see
 * `src-tauri/src/shortcuts/registry.rs:seed_builtins`. Used by the "Reset"
 * button on each row and to render a sensible label when the Rust side
 * hasn't hydrated yet.
 */
const BUILT_IN_DEFAULTS: Array<{ id: string; chord: Chord; label: string }> = [
  { id: "tray.show", chord: "ctrl+shift+space", label: "Show / hide window" },
  { id: "tray.open-logs", chord: "ctrl+shift+l", label: "Open log panel" },
  { id: "tray.automation-kill", chord: "ctrl+alt+k", label: "Automation kill switch" },
]

/**
 * The selection-toolbar chords: the clipboard capture that starts it, plus the
 * six action chords mirroring `SELECTION_ACTION_SHORTCUTS` in
 * `src-tauri/src/selection_toolbar.rs`.
 *
 * The six actions are bound only while the toolbar is running, and
 * `bind_action_shortcuts` deliberately leaves alone any chord the user has
 * already re-bound (ADR-0093 §8). That defence is only reachable if the user
 * has somewhere to re-bind them — which is here.
 */
const SELECTION_SHORTCUT_DEFAULTS = [
  {
    id: "selection.captureClipboard",
    chord: "alt+shift+c",
    labelKey: "selectionCaptureClipboard",
    fallback: "Capture copied selection",
  },
  {
    id: "selection.copy",
    chord: "alt+shift+1",
    labelKey: "selectionCopy",
    fallback: "Selection toolbar: copy",
  },
  {
    id: "selection.explain",
    chord: "alt+shift+2",
    labelKey: "selectionExplain",
    fallback: "Selection toolbar: explain",
  },
  {
    id: "selection.translate",
    chord: "alt+shift+3",
    labelKey: "selectionTranslate",
    fallback: "Selection toolbar: translate",
  },
  {
    id: "selection.ask",
    chord: "alt+shift+4",
    labelKey: "selectionAsk",
    fallback: "Selection toolbar: ask",
  },
  {
    id: "selection.remember",
    chord: "alt+shift+5",
    labelKey: "selectionRemember",
    fallback: "Selection toolbar: add to memory",
  },
  {
    id: "selection.speak",
    chord: "alt+shift+6",
    labelKey: "selectionSpeak",
    fallback: "Selection toolbar: read aloud",
  },
] as const satisfies ReadonlyArray<{ id: string; chord: Chord; labelKey: string; fallback: string }>

/**
 * Ids with no built-in OS-level default (unlike `BUILT_IN_DEFAULTS`, Rust
 * never seeds these — see `seed_builtins`) — the row starts unbound ("Not
 * set") until the user records one. `id` must match a command registered in
 * `lib/plugin/commands/registry.ts` so the bound chord actually dispatches
 * somewhere (see `lib/pet/commands.ts:registerPetCommands`).
 */
const OPTIONAL_SHORTCUT_IDS = ["pet.toggle-window"] as const

interface RecorderState {
  id: string
  chord: Chord | null
  conflict: string | null
}

export function ShortcutsSection() {
  const t = useTranslations("settings.shortcuts")
  const bindings = useShortcutStore((s) => s.bindings)
  const hydrated = useShortcutStore((s) => s.hydrated)
  const hydrate = useShortcutStore((s) => s.hydrate)
  const bind = useShortcutStore((s) => s.bind)
  const unbind = useShortcutStore((s) => s.unbind)
  const conflictFor = useShortcutStore((s) => s.conflictFor)
  const [recorder, setRecorder] = useState<RecorderState | null>(null)
  const recorderRef = useRef<RecorderState | null>(null)
  // eslint-disable-next-line react-hooks/refs -- sync ref during render so the keydown handler captures latest recorder; standard pattern for ref-tracked async state.
  recorderRef.current = recorder
  const trayItems = useTrayStore((s) => s.items)

  useEffect(() => {
    if (hydrated) return
    void hydrate()
  }, [hydrated, hydrate])

  useEffect(() => {
    if (!recorder) return
    function onKey(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") {
        return
      }
      const chord = parseKeyEvent(e)
      void (async () => {
        const owner = await conflictFor(chord, recorderRef.current?.id)
        setRecorder({ id: recorderRef.current!.id, chord, conflict: owner })
      })()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [recorder, conflictFor])

  if (!isTauri()) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("desktopOnly", {
          fallback: "Global shortcuts are only available in the desktop build.",
        })}
      </div>
    )
  }

  async function save() {
    if (!recorder || !recorder.chord) return
    if (recorder.conflict && recorder.conflict !== recorder.id) {
      toast.error(t("conflictBlocked", { fallback: "Chord already bound" }), {
        description: `${recorder.conflict} → ${recorder.chord}`,
      })
      return
    }
    const result = await bind({ id: recorder.id, chord: recorder.chord, scope: "global" })
    if (!result.ok) {
      toast.error(t("bindFailed", { fallback: "Failed to bind shortcut" }), {
        description: result.error,
      })
      return
    }
    setRecorder(null)
  }

  function startRecording(id: string) {
    setRecorder({ id, chord: null, conflict: null })
  }

  async function resetRow(id: string) {
    const def =
      BUILT_IN_DEFAULTS.find((b) => b.id === id) ??
      SELECTION_SHORTCUT_DEFAULTS.find((b) => b.id === id)
    if (!def) {
      await unbind(id)
      return
    }
    await bind({ id, chord: def.chord, scope: "global" })
  }

  // Surface user-pinned tray items that carry an accelerator as additional
  // rebindable rows. Items without an accelerator are still bindable via the
  // settings dialog later, but only appear here once they have one — keeps
  // the panel scoped to "things with a current chord".
  const trayShortcutRows: Array<{ id: string; label: string; chord: Chord | null }> = []
  for (const item of trayItems) {
    if (item.kind !== "action") continue
    const accel: string | undefined = (item as Extract<TrayMenuItem, { kind: "action" }>)
      .accelerator
    if (!accel) continue
    if (BUILT_IN_DEFAULTS.some((b) => b.id === item.id)) continue // already covered
    trayShortcutRows.push({
      id: item.id,
      label: item.label,
      chord: bindings[item.id] ?? accel,
    })
  }

  const optionalLabels: Record<(typeof OPTIONAL_SHORTCUT_IDS)[number], string> = {
    "pet.toggle-window": t("petToggleWindow", { fallback: "Toggle desktop pet" }),
  }
  const optionalShortcutRows: Array<{ id: string; label: string; chord: Chord | null }> =
    OPTIONAL_SHORTCUT_IDS.map((id) => ({
      id,
      label: optionalLabels[id],
      chord: bindings[id] ?? null,
    }))

  const rows: Array<{ id: string; label: string; chord: Chord | null; hasDefault: boolean }> = [
    ...BUILT_IN_DEFAULTS.map((def) => ({
      id: def.id,
      label: def.label,
      chord: bindings[def.id] ?? def.chord,
      hasDefault: true,
    })),
    ...SELECTION_SHORTCUT_DEFAULTS.map((def) => ({
      id: def.id,
      label: t(def.labelKey, { fallback: def.fallback }),
      chord: bindings[def.id] ?? def.chord,
      hasDefault: true,
    })),
    ...trayShortcutRows.map((row) => ({ ...row, hasDefault: false })),
    ...optionalShortcutRows.map((row) => ({ ...row, hasDefault: false })),
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyboardIcon className="size-4" />
        <h2 className="text-base font-semibold">{t("title", { fallback: "Global shortcuts" })}</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("description", {
          fallback: "Rebind the global hot-keys. Recording captures the next key combo you press.",
        })}
      </p>

      <ul className="divide-y rounded-md border bg-card">
        {rows.map((row) => {
          const isRecording = recorder?.id === row.id
          return (
            <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div>
                <div className="text-sm font-medium">{row.label}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {isRecording
                    ? recorder?.chord
                      ? formatKeybinding(recorder.chord)
                      : t("pressKey", { fallback: "Press any key…" })
                    : row.chord
                      ? formatKeybinding(row.chord)
                      : t("notSet", { fallback: "Not set" })}
                </div>
                {isRecording && recorder?.conflict && recorder.conflict !== row.id && (
                  <div className="text-xs text-destructive">
                    {t("conflictWith", { fallback: "Conflicts with" })} {recorder.conflict}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isRecording ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setRecorder(null)}>
                      {t("cancel", { fallback: "Cancel" })}
                    </Button>
                    <Button size="sm" onClick={save} disabled={!recorder?.chord}>
                      {t("save", { fallback: "Save" })}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => startRecording(row.id)}>
                      {t("record", { fallback: "Record" })}
                    </Button>
                    {(row.hasDefault || row.chord) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => resetRow(row.id)}
                        aria-label={
                          row.hasDefault
                            ? t("resetItem", { fallback: "Reset to default" })
                            : t("clear", { fallback: "Clear" })
                        }
                      >
                        <RotateCcwIcon className="size-4" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
