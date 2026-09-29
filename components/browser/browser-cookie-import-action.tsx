"use client"

import { CookieIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"

import { BrowserCookieImportDialog } from "@/components/browser/cookie-import/browser-cookie-import-dialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import { clearSiteCookies } from "@/lib/browser/cookie-import"
import { localBrowser } from "@/lib/browser/local-client"

function publicHttpHostname(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !hostname.includes(".") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
      hostname.includes(":")
    ) {
      return null
    }
    return hostname
  } catch {
    return null
  }
}

/** How "sign out of this site" works on a backend. */
type ClearMode = "embedded" | "local" | "userChrome"

function clearModeFor(backend: BrowserBackend): ClearMode | null {
  if (backend === "embedded") return "embedded"
  if (backend === "local-chromium") return "local"
  if (backend === "user-chrome") return "userChrome"
  return null
}

/**
 * Sign-in for the site the browser pane is showing (ADR-0073, amended by
 * ADR-0201): reuse one from another browser on this device through
 * {@link BrowserCookieImportDialog}, or remove the site's cookies.
 *
 * The two halves are gated differently on purpose. Import reads another
 * browser's credentials, so the import dialog owns the Settings switch and the
 * consent step. Clearing only removes what this browser already holds, so it
 * is offered for any public page without either — turning the feature off is
 * exactly when someone wants an imported sign-in gone. On the user's own
 * Chrome clearing is left to Chrome itself: that is their real profile.
 */
export function BrowserCookieImportAction({
  currentUrl,
  onReload,
  backend = "embedded",
  sessionId,
}: {
  currentUrl: string | null
  onReload: () => Promise<void>
  /**
   * Which engine is showing the page. The cloud browser and the web fallback
   * run on another machine, so the action renders disabled with that reason
   * rather than disappearing (working rule 7).
   */
  backend?: BrowserBackend
  /** Local runtime session for `local-chromium` / `user-chrome`. */
  sessionId?: string
}) {
  const t = useTranslations("browser.cookieImport")
  const tv = useTranslations("browserVault.cookieAction")
  const [open, setOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const domain = publicHttpHostname(currentUrl)
  const clearMode = clearModeFor(backend)

  // Nothing to hold a sign-in for: the whole action is inert.
  const unavailableReason =
    clearMode === null ? t("reason.remoteBackend") : !domain ? t("reason.openPage") : null

  const openImport = () => {
    setOpen(false)
    setImportOpen(true)
  }

  const runClear = async () => {
    if (!domain || clearing) return
    setClearing(true)
    try {
      if (clearMode === "local") {
        if (!sessionId) return
        const result = await localBrowser.rpc<{ cleared?: number } | null>(
          "browser.cookies.clear",
          {
            sessionId,
            domain,
          }
        )
        await onReload()
        const removed = typeof result?.cleared === "number" ? result.cleared : null
        if (removed === 0) toast.info(t("clear.none", { domain }))
        else if (removed === null) toast.success(tv("localCleared", { domain }))
        else toast.success(t("clear.done", { count: removed, domain }))
      } else {
        const result = await clearSiteCookies(domain)
        if (result.removed > 0) {
          // The page still has the signed-in document; reloading is what makes
          // "signed out" true on screen.
          await onReload()
          toast.success(t("clear.done", { count: result.removed, domain: result.domain }))
        } else {
          toast.info(t("clear.none", { domain: result.domain }))
        }
      }
      setOpen(false)
    } catch {
      toast.error(t("clear.failed"))
    } finally {
      setClearing(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={unavailableReason !== null}
                  aria-label={t("action")}
                >
                  <CookieIcon />
                </Button>
              </DialogTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent>{unavailableReason ?? t("action")}</TooltipContent>
        </Tooltip>
        {unavailableReason && <span className="sr-only">{unavailableReason}</span>}

        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialogTitle", { host: domain ?? "" })}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>

          <section aria-labelledby="browser-cookie-import-heading" className="grid gap-3">
            <div className="space-y-1">
              <h3 id="browser-cookie-import-heading" className="text-sm font-medium">
                {t("title")}
              </h3>
              <p className="text-xs text-muted-foreground">{t("description")}</p>
            </div>
            <Button size="sm" className="justify-self-end" onClick={openImport}>
              {tv("chooseImport")}
            </Button>
          </section>

          <Separator />

          <section aria-labelledby="browser-cookie-clear-heading" className="grid gap-2">
            <div className="space-y-1">
              <h3 id="browser-cookie-clear-heading" className="text-sm font-medium">
                {t("clear.title")}
              </h3>
              <p className="text-xs text-muted-foreground" data-testid="browser-cookie-clear-note">
                {clearMode === "userChrome"
                  ? tv("userChromeClear")
                  : clearMode === "local"
                    ? sessionId
                      ? tv("localClearDescription", { domain: domain ?? "" })
                      : tv("localNoSession")
                    : t("clear.description", { domain: domain ?? "" })}
              </p>
            </div>
            {clearMode !== "userChrome" && (
              <Button
                size="sm"
                variant="outline"
                className="justify-self-end text-destructive hover:text-destructive"
                disabled={!domain || clearing || (clearMode === "local" && !sessionId)}
                onClick={() => void runClear()}
              >
                {clearing ? t("clear.clearing") : t("clear.action")}
              </Button>
            )}
          </section>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("close")}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BrowserCookieImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        backend={backend}
        sessionId={sessionId}
        currentHost={domain}
        onImported={onReload}
      />
    </>
  )
}
