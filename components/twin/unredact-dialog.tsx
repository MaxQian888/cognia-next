"use client"

/**
 * Drafts → Accept PII restore dialog (M2).
 *
 * When a distill draft contains placeholder tokens like `<EMAIL_001>`,
 * this dialog reveals the original PII (decrypted from
 * `twinSources.redactionMapEnc`) and lets the user keep or restore each
 * one before the draft is written as a real Character / Skill row.
 *
 * Default: all placeholders restored. The user can flip any individual
 * checkbox if they want the placeholder to survive in the final
 * payload — useful when a downstream Character is shared / exported and
 * the user wants the placeholder to stand in for their address.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import type { UnredactPlaceholder } from "@/lib/twin/distill/unredact-draft"

export interface UnredactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  placeholders: ReadonlyArray<UnredactPlaceholder>
  /**
   * Called with the user's final selection after they hit Confirm. The
   * caller writes the rows and closes the dialog (no implicit close —
   * the dialog stays open if the caller flags an error).
   */
  onConfirm: (
    selection: ReadonlyArray<Pick<UnredactPlaceholder, "placeholder" | "original" | "keep">>
  ) => Promise<void> | void
  busy?: boolean
  /** Optional accept-button label override (e.g. "Accept N drafts"). */
  confirmLabel?: string
}

const KIND_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  EMAIL: "secondary",
  PHONE: "secondary",
  CN_ID: "destructive",
  BANK_CARD: "destructive",
  NAME: "outline",
  IP_ADDR: "secondary",
  API_KEY: "destructive",
  PASSPORT: "destructive",
  DRIVER_LICENSE: "destructive",
}

export function UnredactDialog({
  open,
  onOpenChange,
  placeholders,
  onConfirm,
  busy = false,
  confirmLabel,
}: UnredactDialogProps) {
  const t = useTranslations("twin.unredact")
  // Local mutable selection — reset every time the dialog opens with new
  // placeholders so the user always starts from the "restore all" default.
  const [selection, setSelection] = useState<UnredactPlaceholder[]>(() =>
    placeholders.map((p) => ({ ...p, keep: true }))
  )
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevPlaceholders, setPrevPlaceholders] = useState(placeholders)
  if (open !== prevOpen || placeholders !== prevPlaceholders) {
    setPrevOpen(open)
    setPrevPlaceholders(placeholders)
    if (open) {
      setSelection(placeholders.map((p) => ({ ...p, keep: true })))
    }
  }

  const restoredCount = useMemo(() => selection.filter((p) => p.keep).length, [selection])

  const toggle = (placeholder: string) => {
    setSelection((prev) =>
      prev.map((p) => (p.placeholder === placeholder ? { ...p, keep: !p.keep } : p))
    )
  }
  const restoreAll = () => setSelection((prev) => prev.map((p) => ({ ...p, keep: true })))
  const keepAll = () => setSelection((prev) => prev.map((p) => ({ ...p, keep: false })))

  const handleConfirm = async () => {
    await onConfirm(
      selection.map(({ placeholder, original, keep }) => ({ placeholder, original, keep }))
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? null : onOpenChange(o))}>
      <DialogContent className="max-w-2xl" data-testid="twin-unredact-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { restored: restoredCount, total: placeholders.length })}
          </DialogDescription>
        </DialogHeader>
        {placeholders.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">{t("noPlaceholders")}</p>
        ) : (
          <>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={restoreAll} disabled={busy}>
                {t("restoreAll")}
              </Button>
              <Button size="sm" variant="outline" onClick={keepAll} disabled={busy}>
                {t("keepAll")}
              </Button>
            </div>
            <ul className="flex max-h-72 flex-col gap-2 overflow-auto">
              {selection.map((p) => (
                <li
                  key={p.placeholder}
                  className="border-border flex items-center gap-3 rounded border p-2"
                  data-testid={`twin-unredact-row-${p.placeholder}`}
                >
                  <Checkbox
                    checked={p.keep}
                    onCheckedChange={() => toggle(p.placeholder)}
                    disabled={busy}
                    aria-label={t("checkboxAria", { placeholder: p.placeholder })}
                  />
                  <Badge variant={KIND_TONE[p.kind] ?? "secondary"} className="font-mono">
                    {p.kind}
                  </Badge>
                  <code className="text-muted-foreground text-xs">{p.placeholder}</code>
                  <span className="text-muted-foreground">→</span>
                  <span className="truncate font-mono text-sm">{p.original}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={busy}
            data-testid="twin-unredact-confirm"
          >
            {busy ? t("busy") : (confirmLabel ?? t("confirm", { restored: restoredCount }))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
