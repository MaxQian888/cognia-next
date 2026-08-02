"use client"

// The composer's full keyboard / prefix reference.
//
// Mounted unconditionally by the composer but rendered only while open, so it
// costs no layout — which is what lets the `HelperHints` chip row keep retiring
// after onboarding while the vocabulary stays reachable forever (`?` on an
// empty input, or the chip-row link during onboarding).
//
// Everything documented here is behaviour that already exists in
// `composer.tsx`'s key handler and `composer-trigger.ts`; this is the one place
// a user can read it instead of discovering it.

import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** Keyboard rows: an i18n key plus the literal keycaps it documents. */
const SHORTCUT_ROWS: ReadonlyArray<{ key: string; combo: readonly string[] }> = [
  { key: "send", combo: ["⏎"] },
  { key: "newline", combo: ["⇧", "⏎"] },
  { key: "permissionMode", combo: ["⇧", "⇥"] },
  { key: "history", combo: ["↑", "↓"] },
  { key: "complete", combo: ["⇥"] },
  { key: "dismiss", combo: ["Esc"] },
]

const PREFIX_ROWS: ReadonlyArray<{ key: string; prefix: string }> = [
  { key: "slash", prefix: "/" },
  { key: "mention", prefix: "@" },
  { key: "shell", prefix: "!" },
  { key: "memory", prefix: "#" },
]

export interface ComposerCheatsheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ComposerCheatsheet({ open, onOpenChange }: ComposerCheatsheetProps) {
  const t = useTranslations("chat.composer.helperHints")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="composer-cheatsheet">
        <DialogHeader>
          <DialogTitle>{t("cheatsheetTitle")}</DialogTitle>
          <DialogDescription>{t("cheatsheetDescription")}</DialogDescription>
        </DialogHeader>

        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t("keysTitle")}</h3>
          <dl className="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
            {SHORTCUT_ROWS.map((row) => (
              <RowPair key={row.key} label={t(`keys.${row.key}`)}>
                {row.combo.map((cap) => (
                  <Keycap key={cap}>{cap}</Keycap>
                ))}
              </RowPair>
            ))}
          </dl>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t("prefixesTitle")}</h3>
          <dl className="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
            {PREFIX_ROWS.map((row) => (
              <RowPair key={row.key} label={t(`prefixes.${row.key}`)}>
                <Keycap>{row.prefix}</Keycap>
              </RowPair>
            ))}
          </dl>
        </section>

        <p className="text-xs text-muted-foreground">{t("chainingNote")}</p>
      </DialogContent>
    </Dialog>
  )
}

function RowPair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-1">{children}</dt>
      <dd className="text-muted-foreground">{label}</dd>
    </>
  )
}

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs leading-4">
      {children}
    </kbd>
  )
}
