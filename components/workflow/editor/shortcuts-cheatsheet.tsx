"use client"

/**
 * ShortcutsCheatsheet — Cmd/Ctrl+/ opens this dialog with every keyboard
 * binding the editor exposes, grouped by surface (Editor, Canvas, Run,
 * Inspector). The list is static and lives here rather than being scraped
 * from listeners so users see the canonical names regardless of which
 * binding strategy each subsystem happens to use under the hood.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useTranslations } from "next-intl"

interface ShortcutItem {
  keys: string[][]
  /** i18n key under `workflows.shortcuts.items.*` */
  labelKey: string
}

interface ShortcutGroup {
  /** i18n key under `workflows.shortcuts.group.*` */
  groupKey: string
  items: ShortcutItem[]
}

const GROUPS: ShortcutGroup[] = [
  {
    groupKey: "editor",
    items: [
      { keys: [["Ctrl", "S"]], labelKey: "save" },
      { keys: [["Ctrl", "Z"]], labelKey: "undo" },
      { keys: [["Ctrl", "Shift", "Z"]], labelKey: "redo" },
      { keys: [["Ctrl", "K"]], labelKey: "commands" },
      { keys: [["Ctrl", "/"]], labelKey: "shortcuts" },
      { keys: [["Ctrl", "B"]], labelKey: "togglePalette" },
      { keys: [["Ctrl", "J"]], labelKey: "toggleSidebar" },
    ],
  },
  {
    groupKey: "canvas",
    items: [
      { keys: [["Backspace"], ["Delete"]], labelKey: "deleteNode" },
      { keys: [["Space", "+", "Drag"]], labelKey: "panCanvas" },
      { keys: [["Ctrl", "A"]], labelKey: "selectAll" },
      { keys: [["Ctrl", "C"]], labelKey: "copy" },
      { keys: [["Ctrl", "X"]], labelKey: "cut" },
      { keys: [["Ctrl", "V"]], labelKey: "paste" },
      { keys: [["Ctrl", "D"]], labelKey: "duplicate" },
      { keys: [["Ctrl", "G"]], labelKey: "group" },
    ],
  },
  {
    groupKey: "run",
    items: [{ keys: [["Ctrl", "R"]], labelKey: "run" }],
  },
  {
    groupKey: "inspector",
    items: [{ keys: [["Esc"]], labelKey: "closeInspector" }],
  },
]

export interface ShortcutsCheatsheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShortcutsCheatsheet({ open, onOpenChange }: ShortcutsCheatsheetProps) {
  const t = useTranslations("workflows.shortcuts")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("title")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.groupKey} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`group.${group.groupKey}`)}
              </h3>
              <ul className="space-y-1.5 text-sm">
                {group.items.map((item, idx) => (
                  <li key={idx} className="flex items-center justify-between gap-3">
                    <span className="text-foreground">{t(`items.${item.labelKey}`)}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {item.keys.map((combo, k) => (
                        <KbdGroup key={k}>
                          {combo.map((key, i) => (
                            <Kbd key={i}>{key}</Kbd>
                          ))}
                        </KbdGroup>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
