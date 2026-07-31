"use client"

/**
 * "Share via link" entry for the Discover inspector. Renders only for the four
 * portable definition kinds (character / skill / team / workflowTemplate);
 * returns null for everything else (config/credentials and personal twin data
 * are never publicly shareable).
 *
 * Privacy gate: the sanitized definition is scanned with `hasNoLeakingPii`
 * BEFORE anything is encrypted/uploaded. Clean → opens `ShareLinkDialog`
 * directly. PII detected → a confirm step offers "remove and continue"
 * (default-safe redaction) or "share anyway", mirroring the mobile twin
 * redact-review flow. The dialog's own preview lets the owner see exactly what
 * recipients receive before publishing.
 */

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Link2Icon, ShieldAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { discoverItemPayload } from "@/lib/share/payload"
import {
  buildSharedDefinition,
  definitionHasPii,
  redactSharedDefinition,
  type SharedDiscoverDefinition,
} from "@/lib/share/discover-item"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

export function DiscoverShareButton({ item }: { item: DiscoverItem }) {
  const t = useTranslations("discover.share")
  const locale = useLocale()
  const def = useMemo(
    () => buildSharedDefinition(item, locale === "zh-CN" ? "zh-CN" : "en"),
    [item, locale]
  )
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [pendingDef, setPendingDef] = useState<SharedDiscoverDefinition | null>(null)

  if (!def) return null

  const onShareClick = () => {
    if (definitionHasPii(def)) {
      setConfirmOpen(true)
    } else {
      setPendingDef(def)
      setShareOpen(true)
    }
  }

  const continueWith = (redact: boolean) => {
    setPendingDef(redact ? redactSharedDefinition(def) : def)
    setConfirmOpen(false)
    setShareOpen(true)
  }

  const active = pendingDef ?? def

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={onShareClick}
        data-testid="discover-share-button"
      >
        <Link2Icon className="size-4" />
        {t("action")}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlertIcon className="size-4 text-destructive" />
              {t("piiTitle")}
            </DialogTitle>
            <DialogDescription>{t("piiBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              data-testid="discover-share-cancel"
            >
              {t("cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => continueWith(false)}
              data-testid="discover-share-original"
            >
              {t("shareOriginal")}
            </Button>
            <Button onClick={() => continueWith(true)} data-testid="discover-share-redacted">
              {t("shareRedacted")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={(open) => {
          setShareOpen(open)
          if (!open) setPendingDef(null)
        }}
        buildPayload={() => discoverItemPayload(active, active.name)}
      />
    </>
  )
}
