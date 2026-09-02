"use client"

/**
 * "Share via link" for a saved chat template.
 *
 * The full three-answer PII gate from `discover-share-button.tsx` applies here,
 * unlike the template-definition button: nothing in a chat template's shareable
 * body is hash-covered, so a redacted share is still a valid share.
 *
 * The launch spec is demoted by `buildSharedChatTemplate` before the payload is
 * built, so what the preview shows is exactly what a recipient receives.
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
import { chatTemplatePayload } from "@/lib/share/payload"
import {
  buildSharedChatTemplate,
  redactSharedChatTemplate,
  sharedChatTemplateHasPii,
  type ShareableChatTemplate,
  type SharedChatTemplate,
} from "@/lib/share/chat-template"

export interface ChatTemplateShareButtonProps {
  template: ShareableChatTemplate
  size?: "sm" | "default"
  className?: string
}

export function ChatTemplateShareButton({
  template,
  size = "sm",
  className,
}: ChatTemplateShareButtonProps) {
  const t = useTranslations("share")
  const shared = useMemo(() => buildSharedChatTemplate(template), [template])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [pending, setPending] = useState<SharedChatTemplate | null>(null)

  const onShareClick = () => {
    if (sharedChatTemplateHasPii(shared)) {
      setConfirmOpen(true)
      return
    }
    setPending(shared)
    setShareOpen(true)
  }

  const continueWith = (redact: boolean) => {
    setPending(redact ? redactSharedChatTemplate(shared) : shared)
    setConfirmOpen(false)
    setShareOpen(true)
  }

  const active = pending ?? shared

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        className={className}
        onClick={onShareClick}
        data-testid="chat-template-share-button"
      >
        <Link2Icon className="size-3.5" />
        {t("shareAction")}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlertIcon className="size-4 text-destructive" />
              {t("pii.title")}
            </DialogTitle>
            <DialogDescription>{t("pii.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              data-testid="chat-template-share-cancel"
            >
              {t("pii.cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => continueWith(false)}
              data-testid="chat-template-share-original"
            >
              {t("pii.shareOriginal")}
            </Button>
            <Button onClick={() => continueWith(true)} data-testid="chat-template-share-redacted">
              {t("pii.shareRedacted")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={(open) => {
          setShareOpen(open)
          if (!open) setPending(null)
        }}
        buildPayload={() => chatTemplatePayload(active)}
      />
    </>
  )
}
