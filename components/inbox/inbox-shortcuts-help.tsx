"use client"

/**
 * The Inbox list's keyboard help (`?`).
 *
 * Drawn from `INBOX_TRIAGE_SHORTCUTS` — the same table the keymap resolves —
 * so the dialog cannot list a key the list ignores, or miss one it honours.
 * Grouped as headed sections with separators, keys as `Kbd`, no cards.
 */

import { Fragment } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { INBOX_TRIAGE_SHORTCUTS, type TriageShortcutEntry } from "@/lib/inbox/triage-keymap"
import { usesAppleModifierGlyphs } from "@/lib/platform/os"

const GROUPS: ReadonlyArray<TriageShortcutEntry["group"]> = ["navigate", "select", "triage"]

/** Named tokens the dialog translates; anything else is printed as typed. */
const NAMED_KEYS = new Set(["shift", "enter", "escape", "up", "down", "home", "end"])

export interface InboxShortcutsHelpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InboxShortcutsHelp({ open, onOpenChange }: InboxShortcutsHelpProps) {
  const t = useTranslations("inbox.shortcuts")
  const apple = usesAppleModifierGlyphs()

  const keyLabel = (token: string): string => {
    if (token === "mod") return apple ? "⌘" : t("keys.ctrl")
    if (NAMED_KEYS.has(token)) return t(`keys.${token}`)
    return token.toUpperCase()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-md"
        data-testid="inbox-shortcuts-help"
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {GROUPS.map((group, index) => (
          <Fragment key={group}>
            {index > 0 && <Separator />}
            <section aria-labelledby={`inbox-shortcuts-${group}`}>
              <h3
                id={`inbox-shortcuts-${group}`}
                className="mb-1.5 text-xs font-medium text-muted-foreground"
              >
                {t(`groups.${group}`)}
              </h3>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
                {INBOX_TRIAGE_SHORTCUTS.filter((entry) => entry.group === group).map((entry) => (
                  <div
                    key={entry.id}
                    className="col-span-2 grid grid-cols-subgrid items-center"
                    data-testid={`inbox-shortcut-${entry.id}`}
                  >
                    <dt>{t(`actions.${entry.id}`)}</dt>
                    <dd className="flex flex-wrap items-center justify-end gap-1">
                      {entry.keys.map((combo, comboIndex) => (
                        <Fragment key={combo.join("+")}>
                          {comboIndex > 0 && (
                            <span aria-hidden className="text-xs text-muted-foreground">
                              /
                            </span>
                          )}
                          <KbdGroup>
                            {combo.map((token) => (
                              <Kbd key={token}>{keyLabel(token)}</Kbd>
                            ))}
                          </KbdGroup>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </Fragment>
        ))}
      </DialogContent>
    </Dialog>
  )
}
