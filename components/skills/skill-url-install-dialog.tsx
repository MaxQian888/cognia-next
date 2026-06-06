"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, LinkIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { URL_INSTALL_INVALID, useUrlInstall } from "@/hooks/skills"
import { useSkillsStore } from "@/stores/skills/skills-store"
import { loggers } from "@/lib/logging"

/**
 * "Install from URL" dialog: paste a skills.sh page link, an
 * `owner/repo/slug` triple, or a GitHub repository; the resolver installs
 * the snapshot directly. Open state lives in the skills store
 * (`urlInstallOpen`) so both the Browse search row and the toolbar can
 * trigger it.
 */
export function SkillUrlInstallDialog() {
  const t = useTranslations("skills.marketplace.urlInstall")
  const tToasts = useTranslations("skills.toasts")
  const open = useSkillsStore((s) => s.urlInstallOpen)
  const setOpen = useSkillsStore((s) => s.setUrlInstallOpen)
  const { run, busy, error, clearError } = useUrlInstall()
  const [input, setInput] = useState("")

  const close = (next: boolean) => {
    if (busy) return
    setOpen(next)
    if (!next) {
      setInput("")
      clearError()
    }
  }

  const handleInstall = async () => {
    try {
      const item = await run(input)
      toast.success(tToasts("installed", { name: item.name }))
      loggers.skills.info("url install ok", { sourceId: item.sourceId })
      close(false)
    } catch (err) {
      // The hook records the error message for inline rendering; just log.
      loggers.skills.error("url install failed", err, { input })
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Input
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              if (error) clearError()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim() && !busy) void handleInstall()
            }}
            placeholder={t("placeholder")}
            aria-label={t("ariaLabel")}
            autoComplete="off"
            spellCheck={false}
            className="min-h-11 font-mono text-xs md:min-h-9"
            data-testid="skill-url-install-input"
          />
          <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
          {error && (
            <p className="text-xs text-destructive" data-testid="skill-url-install-error">
              {error === URL_INSTALL_INVALID ? t("errorInvalid") : error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => void handleInstall()}
            disabled={busy || !input.trim()}
            className="min-h-11 md:min-h-9"
          >
            {busy ? (
              <Spinner className="mr-1.5 size-3.5" />
            ) : (
              <DownloadIcon className="mr-1.5 size-3.5" />
            )}
            {busy ? t("installing") : t("install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
