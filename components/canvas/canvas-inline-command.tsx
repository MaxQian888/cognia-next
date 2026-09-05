"use client"

/**
 * CanvasInlineCommand — the Ctrl+K command palette for the Canvas editor.
 *
 * Opens on the `canvas-inline-command` window event (dispatched by the
 * keybinding handler `use-canvas-keyboard-shortcuts.ts` and the toolbar's
 * search button). Previously that event had NO listener — the palette was
 * never built — so Ctrl+K and the search button fired into the void. This
 * component is the missing listener: it surfaces the AI actions, translate
 * targets, and document commands the editor already exposes so they're all
 * reachable from one searchable list.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { CANVAS_ACTIONS, TRANSLATE_LANGUAGES } from "@/lib/canvas/constants"
import type { CanvasActionType } from "@/lib/ai/generation/canvas-actions"

export interface CanvasInlineCommandProps {
  /** Disables AI actions while a generation is already running. */
  running: boolean
  onAction: (type: CanvasActionType, opts?: { targetLanguage?: string }) => void
  onSaveVersion: () => void
  onTriggerSuggestions: () => void
  onCreateDocument: () => void
  /**
   * Whether the palette is open. Lifted out of local state so it is the
   * document's `aiWorkbench.isInlineCommandOpen`, which the type has declared
   * since it was written and nothing ever set.
   */
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CanvasInlineCommand({
  running,
  onAction,
  onSaveVersion,
  onTriggerSuggestions,
  onCreateDocument,
  open,
  onOpenChange,
}: CanvasInlineCommandProps) {
  const t = useTranslations("canvas.inlineCommand")
  const tActions = useTranslations("canvas.actions")
  useEffect(() => {
    const handler = () => onOpenChange(!open)
    window.addEventListener("canvas-inline-command", handler)
    return () => window.removeEventListener("canvas-inline-command", handler)
  }, [onOpenChange, open])

  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }

  // Translate is expanded into per-language items; the rest map 1:1 to actions.
  const primaryActions = CANVAS_ACTIONS.filter((a) => a.type !== "translate")

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("placeholder")} />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>
        <CommandGroup heading={t("groupActions")}>
          {primaryActions.map((action) => (
            <CommandItem
              key={action.type}
              value={`action-${action.type}`}
              disabled={running}
              onSelect={() => run(() => onAction(action.type as CanvasActionType))}
            >
              {tActions(action.type)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading={t("groupTranslate")}>
          {TRANSLATE_LANGUAGES.map((lang) => (
            <CommandItem
              key={lang.value}
              value={`translate-${lang.value}`}
              disabled={running}
              onSelect={() => run(() => onAction("translate", { targetLanguage: lang.value }))}
            >
              {`${tActions("translate")} · ${lang.label}`}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading={t("groupDocument")}>
          <CommandItem
            value="suggest"
            disabled={running}
            onSelect={() => run(onTriggerSuggestions)}
          >
            {tActions("suggest")}
          </CommandItem>
          <CommandItem value="save-version" onSelect={() => run(onSaveVersion)}>
            {tActions("saveVersion")}
          </CommandItem>
          <CommandItem value="new-document" onSelect={() => run(onCreateDocument)}>
            {t("newDocument")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

export default CanvasInlineCommand
