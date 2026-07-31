"use client"

import { CookieIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
  cookieImportMessage,
  importChromeCookies,
  isChromeCookieImportAvailable,
  type ChromiumBrowser,
  type CookieImportAvailability,
} from "@/lib/browser/cookie-import"
import { useSettingsStore } from "@/stores/settings/settings-store"

const CONSENT_STORAGE_KEY = "cognia.browser.cookie-import-consent.v1"

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

export function BrowserCookieImportAction({
  currentUrl,
  onReload,
}: {
  currentUrl: string | null
  onReload: () => Promise<void>
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
  const [consented, setConsented] = useState(() =>
    typeof window === "undefined" ? false : window.localStorage.getItem(CONSENT_STORAGE_KEY) === "1"
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
  const reason = !featureEnabled
    ? t("reason.featureDisabled")
    : !domain
      ? t("reason.openPage")
      : Object.keys(availability).length === 0
        ? t("reason.checking")
        : !CHROMIUM_BROWSERS.some((candidate) => availability[candidate]?.profiles.length)
          ? firstReason === "macos_only"
            ? t("reason.unsupported")
            : firstReason === "probe_failed"
              ? t("reason.checkFailed")
              : t("reason.noProfiles")
          : null
  const disabled = reason !== null
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
    window.localStorage.setItem(CONSENT_STORAGE_KEY, "1")
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
                disabled={disabled}
                aria-label={t("action")}
              >
                <CookieIcon />
              </Button>
            </DialogTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason ?? t("action")}</TooltipContent>
      </Tooltip>
      {reason && <span className="sr-only">{reason}</span>}

      <DialogContent>
        {!consented ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("consent.title")}</DialogTitle>
              <DialogDescription>{t("consent.description")}</DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t("consent.localOnly")}</p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t("cancel")}</Button>
              </DialogClose>
              <Button onClick={grantConsent}>{t("consent.continue")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <label className="grid gap-1.5 text-sm">
                <span>{t("browserLabel")}</span>
                <select
                  value={browser}
                  onChange={(event) => selectBrowser(event.target.value as ChromiumBrowser)}
                  className="h-9 rounded-md border bg-background px-3"
                >
                  {browserOptions.map((option) => (
                    <option
                      key={option.browser}
                      value={option.browser}
                      disabled={option.profiles.length === 0}
                    >
                      {t(`browser.${option.browser}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span>{t("profileLabel")}</span>
                <select
                  value={profile}
                  onChange={(event) => setProfile(event.target.value)}
                  className="h-9 rounded-md border bg-background px-3"
                >
                  {profiles.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">{t("keychainHint")}</p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t("cancel")}</Button>
              </DialogClose>
              <Button disabled={!profile || importing} onClick={() => void runImport()}>
                {importing ? t("importing") : t("import")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
