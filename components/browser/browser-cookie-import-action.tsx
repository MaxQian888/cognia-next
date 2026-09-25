"use client"

import { CookieIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
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
import {
  CHROMIUM_BROWSERS,
  clearSiteCookies,
  cookieImportMessage,
  importChromeCookies,
  isChromeCookieImportAvailable,
  type ChromiumBrowser,
  type CookieImportAvailability,
} from "@/lib/browser/cookie-import"
import { COOKIE_IMPORT_CONSENT_STORAGE_KEY } from "@/lib/browser/preview-data"
import { useSettingsStore } from "@/stores/settings/settings-store"

const DESKTOP_SETTINGS_HREF = "/settings?section=desktop"

/** Why import specifically cannot run — the dialog still offers clearing. */
type ImportBlocker = "featureDisabled" | "checking" | "unsupported" | "checkFailed" | "noProfiles"

type AvailabilityMap = Partial<Record<ChromiumBrowser, CookieImportAvailability>>

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

/**
 * Sign-in for the site the embedded preview is showing (ADR-0073): reuse one
 * from a local Chromium profile, or remove the site's cookies from the preview.
 *
 * The two halves are gated differently on purpose. Import reads another
 * browser's credentials, so it needs the Settings switch, a supported platform,
 * a profile and the user's consent. Clearing only removes what the preview
 * already holds, so it is offered for any public page — including after the
 * switch is turned off, which used to leave imported cookies in place with no
 * way anywhere to remove them.
 */
export function BrowserCookieImportAction({
  currentUrl,
  onReload,
  backend = "embedded",
}: {
  currentUrl: string | null
  onReload: () => Promise<void>
  /**
   * Which engine is showing the page.
   *
   * Cookie import reads *this machine's* Chromium keychain and writes into
   * *this machine's* WKWebView store, so it is embedded-only by construction —
   * a cloud Chromium is a different browser on a different host. Rendering it
   * disabled with that reason, rather than omitting it, is what stops "the
   * cookie button disappeared" from reading as a bug (working rule 7).
   */
  backend?: "embedded" | "remote"
}) {
  const t = useTranslations("browser.cookieImport")
  const featureEnabled = useSettingsStore(
    (state) => state.settings?.browserCookieImportEnabled ?? false
  )
  const [availability, setAvailability] = useState<AvailabilityMap>({})
  const [browser, setBrowser] = useState<ChromiumBrowser>("chrome")
  const [profile, setProfile] = useState("")
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [consented, setConsented] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.localStorage.getItem(COOKIE_IMPORT_CONSENT_STORAGE_KEY) === "1"
  )
  const domain = publicHttpHostname(currentUrl)

  useEffect(() => {
    if (!featureEnabled || !domain) return
    let cancelled = false
    void Promise.allSettled(
      CHROMIUM_BROWSERS.map(
        async (candidate) =>
          [candidate, await isChromeCookieImportAvailable(candidate, true)] as const
      )
    ).then((settled) => {
      if (cancelled) return
      const entries = settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : ([
              CHROMIUM_BROWSERS[index],
              { supported: false, profiles: [], reason: "probe_failed" },
            ] as const)
      )
      const next = Object.fromEntries(entries) as AvailabilityMap
      setAvailability(next)
      const first = CHROMIUM_BROWSERS.find((candidate) => next[candidate]?.profiles.length)
      if (first) {
        setBrowser(first)
        setProfile(next[first]?.profiles[0] ?? "")
      }
    })
    return () => {
      cancelled = true
    }
  }, [domain, featureEnabled])

  const selectedAvailability = availability[browser]
  const firstReason = CHROMIUM_BROWSERS.map((candidate) => availability[candidate]?.reason).find(
    Boolean
  )
  // Nothing to hold a sign-in for: the whole action is inert.
  const unavailableReason =
    backend === "remote" ? t("reason.remoteBackend") : !domain ? t("reason.openPage") : null
  const importBlocker: ImportBlocker | null = !featureEnabled
    ? "featureDisabled"
    : Object.keys(availability).length === 0
      ? "checking"
      : !CHROMIUM_BROWSERS.some((candidate) => availability[candidate]?.profiles.length)
        ? firstReason === "macos_only"
          ? "unsupported"
          : firstReason === "probe_failed"
            ? "checkFailed"
            : "noProfiles"
        : null
  const profiles = selectedAvailability?.profiles ?? []
  const browserOptions = useMemo(
    () =>
      CHROMIUM_BROWSERS.map((candidate) => ({
        browser: candidate,
        profiles: availability[candidate]?.profiles ?? [],
      })),
    [availability]
  )

  const grantConsent = () => {
    window.localStorage.setItem(COOKIE_IMPORT_CONSENT_STORAGE_KEY, "1")
    setConsented(true)
  }

  const selectBrowser = (next: ChromiumBrowser) => {
    setBrowser(next)
    setProfile(availability[next]?.profiles[0] ?? "")
  }

  const runImport = async () => {
    if (!domain || !profile || importing) return
    setImporting(true)
    try {
      const result = await importChromeCookies({
        browser,
        profile,
        domain,
        featureEnabled,
      })
      const message = cookieImportMessage(result)
      if (result.kind === "ok") {
        await onReload()
        toast.success(t(message.key, message.values))
        setOpen(false)
      } else {
        toast.error(t(message.key))
      }
    } catch {
      toast.error(t("result.failed"))
    } finally {
      setImporting(false)
    }
  }

  const runClear = async () => {
    if (!domain || clearing) return
    setClearing(true)
    try {
      const result = await clearSiteCookies(domain)
      if (result.removed > 0) {
        // The page still has the signed-in document; reloading is what makes
        // "signed out" true on screen.
        await onReload()
        toast.success(t("clear.done", { count: result.removed, domain: result.domain }))
      } else {
        toast.info(t("clear.none", { domain: result.domain }))
      }
      setOpen(false)
    } catch {
      toast.error(t("clear.failed"))
    } finally {
      setClearing(false)
    }
  }

  const busy = importing || clearing

  return (
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
          {importBlocker ? (
            <div
              role="status"
              data-testid="browser-cookie-import-blocked"
              className="flex flex-col items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
            >
              <p>{t(`reason.${importBlocker}`)}</p>
              {importBlocker === "featureDisabled" && (
                <Button asChild size="sm" variant="outline">
                  <Link href={DESKTOP_SETTINGS_HREF} onClick={() => setOpen(false)}>
                    {t("openSettings")}
                  </Link>
                </Button>
              )}
            </div>
          ) : !consented ? (
            <div className="grid gap-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t("consent.title")}</p>
              <p className="text-sm text-muted-foreground">{t("consent.description")}</p>
              <p className="text-xs text-muted-foreground">{t("consent.localOnly")}</p>
              <Button size="sm" className="justify-self-end" onClick={grantConsent}>
                {t("consent.continue")}
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid min-w-0 gap-1.5 text-sm">
                  <span>{t("browserLabel")}</span>
                  <NativeSelect
                    value={browser}
                    onChange={(event) => selectBrowser(event.target.value as ChromiumBrowser)}
                    wrapperClassName="w-full"
                  >
                    {browserOptions.map((option) => (
                      <NativeSelectOption
                        key={option.browser}
                        value={option.browser}
                        disabled={option.profiles.length === 0}
                      >
                        {t(`browser.${option.browser}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm">
                  <span>{t("profileLabel")}</span>
                  <NativeSelect
                    value={profile}
                    onChange={(event) => setProfile(event.target.value)}
                    wrapperClassName="w-full"
                  >
                    {profiles.map((candidate) => (
                      <NativeSelectOption key={candidate} value={candidate}>
                        {candidate}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t("keychainHint")}</p>
              <Button
                size="sm"
                className="justify-self-end"
                disabled={!profile || busy}
                onClick={() => void runImport()}
              >
                {importing ? t("importing") : t("import")}
              </Button>
            </div>
          )}
        </section>

        <Separator />

        <section aria-labelledby="browser-cookie-clear-heading" className="grid gap-2">
          <div className="space-y-1">
            <h3 id="browser-cookie-clear-heading" className="text-sm font-medium">
              {t("clear.title")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("clear.description", { domain: domain ?? "" })}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="justify-self-end text-destructive hover:text-destructive"
            disabled={!domain || busy}
            onClick={() => void runClear()}
          >
            {clearing ? t("clear.clearing") : t("clear.action")}
          </Button>
        </section>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("close")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
