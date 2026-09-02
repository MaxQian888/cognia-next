"use client"

/**
 * "Share via link" for a published template release.
 *
 * Mirrors `components/discover/discover-share-button.tsx`, with one deliberate
 * difference: there is no "remove and continue". Every field a redactor would
 * rewrite is inside the definition's hashed body, so redacting would hand the
 * recipient an envelope whose `contentHash` no longer matches its content and
 * destroy the one thing this kind offers over a plain paste. The choice is
 * therefore cancel, or share as it stands and fix the template instead.
 *
 * A definition that cannot be shared is rendered DISABLED with the reason
 * beside it, not hidden. Three different situations reach this component (a
 * draft, a withdrawn release, a payload with a credential field), and a control
 * that simply vanishes turns all three into "there is no share button here".
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
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
import { templateDefinitionPayload } from "@/lib/share/payload"
import {
  buildSharedTemplateDefinition,
  sharedTemplateDefinitionHasPii,
} from "@/lib/share/template-definition"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"

export interface TemplateDefinitionShareButtonProps {
  definition: TemplateDefinitionEnvelope
  /** Rendered smaller inside dense inspector rows. */
  size?: "sm" | "default"
  className?: string
}

export function TemplateDefinitionShareButton({
  definition,
  size = "default",
  className,
}: TemplateDefinitionShareButtonProps) {
  const t = useTranslations("share")
  const built = useMemo(() => buildSharedTemplateDefinition(definition), [definition])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  if (!built.ok) {
    return (
      <div className={className}>
        <Button
          type="button"
          variant="outline"
          size={size}
          disabled
          data-testid="template-share-button"
          data-refusal={built.reason}
        >
          <Link2Icon className="size-4" />
          {t("shareAction")}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="template-share-refusal">
          {t(`templateShare.refusal.${built.reason}`)}
        </p>
      </div>
    )
  }

  const shared = built.shared
  const onShareClick = () => {
    if (sharedTemplateDefinitionHasPii(shared)) setConfirmOpen(true)
    else setShareOpen(true)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        className={className}
        onClick={onShareClick}
        data-testid="template-share-button"
      >
        <Link2Icon className="size-4" />
        {t("shareAction")}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlertIcon className="size-4 text-destructive" />
              {t("pii.title")}
            </DialogTitle>
            <DialogDescription>{t("templateShare.piiBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              data-testid="template-share-cancel"
            >
              {t("pii.cancel")}
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false)
                setShareOpen(true)
              }}
              data-testid="template-share-original"
            >
              {t("pii.shareOriginal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        buildPayload={() => templateDefinitionPayload(shared)}
      />
    </>
  )
}
