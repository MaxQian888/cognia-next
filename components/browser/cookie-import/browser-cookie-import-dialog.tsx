"use client"

import { SearchIcon, ShieldAlertIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import {
  cookieImportV2Message,
  importCookiesV2,
  listCookieDomains,
  listCookieSources,
  openFullDiskAccessSettings,
  type CookieDomainCount,
  type CookieImportScope,
  type CookieImportSink,
  type CookieImportV2Result,
  type CookieSource,
} from "@/lib/browser/cookie-import"
import { COOKIE_IMPORT_CONSENT_STORAGE_KEY } from "@/lib/browser/preview-data"
import { isMacOs } from "@/lib/platform/os"
import { useSettingsStore } from "@/stores/settings/settings-store"

type CookieDomain = CookieDomainCount
type ImportResult = CookieImportV2Result
type ScopeKind = CookieImportScope["kind"]
type Sink = CookieImportSink

const DESKTOP_SETTINGS_HREF = "/settings?section=desktop"
const FULL_DISK_ACCESS = "full_disk_access_required"

/**
 * Where imported cookies go for a backend, or `null` when the backend cannot
 * receive them. The cloud browser and the web fallback run elsewhere, so cookie
 * import is inert there by construction (ADR-0073, amended by ADR-0201).
 */
export function cookieSinkFor(backend: BrowserBackend): Sink | null {
  if (backend === "embedded") return "embedded"
  if (backend === "local-chromium" || backend === "user-chrome") return "local"
  return null
}

function FullDiskAccessGuidance() {
  const t = useTranslations("browserVault.cookieImport.fullDiskAccess")
  const [opening, setOpening] = useState(false)
  const openSettings = async () => {
    setOpening(true)
    try {
      await openFullDiskAccessSettings()
    } catch {
      toast.error(t("openFailed"))
    } finally {
      setOpening(false)
    }
  }
  return (
    <Alert role="note" data-testid="cookie-import-full-disk-access">
      <ShieldAlertIcon />
      <AlertDescription className="grid gap-2">
        <p>{t("description")}</p>
        {isMacOs() && (
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={opening}
            onClick={() => void openSettings()}
          >
            {t("open")}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function DomainPicker({
  domains,
  selected,
  onToggle,
}: {
  domains: CookieDomain[]
  selected: ReadonlySet<string>
  onToggle: (domain: string, checked: boolean) => void
}) {
  const t = useTranslations("browserVault.cookieImport")
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? domains.filter((item) => item.domain.toLowerCase().includes(needle))
    : domains
  if (domains.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("domainsEmpty")}</p>
  }
  return (
    <div className="grid gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={t("domainsSearch")}
          placeholder={t("domainsSearch")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-8"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("domainsSelected", { count: selected.size })}
      </p>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("domainsNoMatch", { query: query.trim() })}
        </p>
      ) : (
        <ul className="max-h-56 overflow-y-auto rounded-md border" aria-label={t("domains")}>
          {visible.map((item) => {
            const id = `cookie-domain-${item.domain}`
            return (
              <li key={item.domain} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <Checkbox
                  id={id}
                  checked={selected.has(item.domain)}
                  onCheckedChange={(checked) => onToggle(item.domain, checked === true)}
                />
                <Label htmlFor={id} className="min-w-0 flex-1 truncate font-normal">
                  {item.domain}
                </Label>
                <span className="text-xs text-muted-foreground">
                  {t("domainsCount", { count: item.count })}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

type DomainsState =
  | { key: string; kind: "loading" }
  | { key: string; kind: "ready"; domains: CookieDomain[] }
  | { key: string; kind: "failed" }

function ImportForm({
  sink,
  sessionId,
  currentHost,
  onDone,
  onImported,
}: {
  sink: Sink
  sessionId?: string
  currentHost?: string | null
  onDone: () => void
  onImported?: (result: ImportResult) => void | Promise<void>
}) {
  const t = useTranslations("browserVault.cookieImport")
  const tCommon = useTranslations("browserVault.common")
  const [sources, setSources] = useState<CookieSource[] | null>(null)
  const [sourcesFailed, setSourcesFailed] = useState(false)
  const [browser, setBrowser] = useState("")
  const [profile, setProfile] = useState("")
  const [scope, setScope] = useState<ScopeKind>(currentHost ? "site" : "domains")
  const [domainsState, setDomainsState] = useState<DomainsState | null>(null)
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(() => new Set())
  const [importing, setImporting] = useState(false)
  const [failure, setFailure] = useState<{ message: string; fullDiskAccess: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    listCookieSources()
      .then((next) => {
        if (cancelled) return
        setSources(next)
        const first = next.find((source) => source.supported && source.profiles.length > 0)
        if (first) {
          setBrowser(first.browser)
          setProfile(first.profiles[0]?.id ?? "")
        } else {
          const blocked = next.find((source) => source.reason === FULL_DISK_ACCESS)
          if (blocked) setBrowser(blocked.browser)
        }
      })
      .catch(() => {
        if (!cancelled) setSourcesFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const domainsKey = `${browser}\u0000${profile}`
  const wantDomains = scope === "domains" && browser !== "" && profile !== ""
  useEffect(() => {
    if (!wantDomains) return
    let cancelled = false
    const key = `${browser}\u0000${profile}`
    listCookieDomains(browser, profile)
      .then((domains) => {
        if (!cancelled) setDomainsState({ key, kind: "ready", domains })
      })
      .catch(() => {
        if (!cancelled) setDomainsState({ key, kind: "failed" })
      })
    return () => {
      cancelled = true
    }
  }, [wantDomains, browser, profile])

  const domains = domainsState?.key === domainsKey ? domainsState : null
  const sortedDomains = useMemo(
    () =>
      domains?.kind === "ready"
        ? [...domains.domains].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
        : [],
    [domains]
  )

  if (sourcesFailed) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadFailed")}
      </p>
    )
  }
  if (!sources) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        {tCommon("loading")}
      </p>
    )
  }
  if (sources.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noSources")}</p>
  }

  const selectedSource = sources.find((source) => source.browser === browser)
  const reasonLabel = (reason: string | null | undefined) => {
    const key = `reason.${reason}`
    return reason && t.has(key) ? t(key) : null
  }
  const selectBrowser = (next: string) => {
    const source = sources.find((candidate) => candidate.browser === next)
    setBrowser(next)
    setProfile(source?.profiles[0]?.id ?? "")
    setSelectedDomains(new Set())
    setFailure(null)
  }
  const toggleDomain = (domain: string, checked: boolean) =>
    setSelectedDomains((current) => {
      const next = new Set(current)
      if (checked) next.add(domain)
      else next.delete(domain)
      return next
    })

  const needsSession = sink === "local" && !sessionId
  const scopeReady =
    scope === "site" ? Boolean(currentHost) : scope === "domains" ? selectedDomains.size > 0 : true
  const canImport =
    Boolean(selectedSource?.supported) &&
    profile !== "" &&
    scopeReady &&
    !needsSession &&
    !importing

  const runImport = async () => {
    if (!canImport) return
    setImporting(true)
    setFailure(null)
    try {
      const result = await importCookiesV2({
        browser,
        profile,
        scope:
          scope === "site"
            ? { kind: "site", domain: currentHost ?? "" }
            : scope === "domains"
              ? { kind: "domains", domains: [...selectedDomains] }
              : { kind: "all" },
        sink,
        ...(sessionId ? { sessionId } : {}),
      })
      const message = cookieImportV2Message(result)
      const text = t(message.key, message.values)
      if (result.kind === "ok") {
        await onImported?.(result)
        toast.success(text)
        if (result.skippedAppBound > 0) {
          toast.info(t("result.appBound", { count: result.skippedAppBound }))
        }
        onDone()
      } else {
        setFailure({ message: text, fullDiskAccess: result.kind === FULL_DISK_ACCESS })
      }
    } catch {
      setFailure({ message: t("result.failed"), fullDiskAccess: false })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1.5 text-sm">
          <span>{t("browser")}</span>
          <NativeSelect
            value={browser}
            wrapperClassName="w-full"
            onChange={(event) => selectBrowser(event.target.value)}
          >
            {sources.map((source) => {
              const reason = source.supported ? null : reasonLabel(source.reason)
              return (
                <NativeSelectOption
                  key={source.browser}
                  value={source.browser}
                  disabled={
                    source.reason !== FULL_DISK_ACCESS &&
                    (!source.supported || source.profiles.length === 0)
                  }
                >
                  {reason ? t("sourceWithReason", { label: source.label, reason }) : source.label}
                </NativeSelectOption>
              )
            })}
          </NativeSelect>
        </label>
        <label className="grid min-w-0 gap-1.5 text-sm">
          <span>{t("profile")}</span>
          <NativeSelect
            value={profile}
            wrapperClassName="w-full"
            disabled={!selectedSource?.supported}
            onChange={(event) => {
              setProfile(event.target.value)
              setSelectedDomains(new Set())
              setFailure(null)
            }}
          >
            {(selectedSource?.profiles ?? []).map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>

      {selectedSource?.reason === FULL_DISK_ACCESS && <FullDiskAccessGuidance />}

      {selectedSource?.supported && (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{t("scope")}</legend>
          <RadioGroup
            value={scope}
            onValueChange={(value) => {
              setScope(value as ScopeKind)
              setFailure(null)
            }}
            className="gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="cookie-scope-site" value="site" disabled={!currentHost} />
              <Label htmlFor="cookie-scope-site" className="font-normal">
                {t("site", { host: currentHost ?? "" })}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="cookie-scope-domains" value="domains" />
              <Label htmlFor="cookie-scope-domains" className="font-normal">
                {t("domains")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="cookie-scope-all" value="all" />
              <Label htmlFor="cookie-scope-all" className="font-normal">
                {t("all")}
              </Label>
            </div>
          </RadioGroup>
          {scope === "all" && <p className="text-xs text-muted-foreground">{t("allHint")}</p>}
          {scope === "domains" &&
            (domains === null || domains.kind === "loading" ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                {tCommon("loading")}
              </p>
            ) : domains.kind === "failed" ? (
              <p role="alert" className="text-sm text-destructive">
                {t("domainsLoadFailed")}
              </p>
            ) : (
              <DomainPicker
                domains={sortedDomains}
                selected={selectedDomains}
                onToggle={toggleDomain}
              />
            ))}
        </fieldset>
      )}

      <p className="text-xs text-muted-foreground">
        {needsSession ? t("sink.localNoSession") : t(`sink.${sink}`)}
      </p>
      <p className="text-xs text-muted-foreground">{t("keychainHint")}</p>

      {failure && (
        <div className="grid gap-2">
          <p role="alert" className="text-sm text-destructive">
            {failure.message}
          </p>
          {failure.fullDiskAccess && selectedSource?.reason !== FULL_DISK_ACCESS && (
            <FullDiskAccessGuidance />
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          {tCommon("close")}
        </Button>
        <Button disabled={!canImport} onClick={() => void runImport()}>
          {importing ? t("importing") : t("import")}
        </Button>
      </DialogFooter>
    </div>
  )
}

function readConsent(): boolean {
  if (typeof window === "undefined") return false
  return window.localStorage.getItem(COOKIE_IMPORT_CONSENT_STORAGE_KEY) === "1"
}

/**
 * Import sign-in cookies from any supported browser on this device
 * (ADR-0073, amended by ADR-0201): Chromium-family browsers, Firefox and
 * Safari; one site, chosen domains (listed with counts, no decryption) or all.
 * Cookies go to the backend's own store — the embedded preview or the running
 * local Chromium session. Values never cross into the renderer; the dialog
 * only sees counts and typed outcomes.
 *
 * Gated like before on the Settings switch and one-time local consent. On the
 * cloud browser / web fallback the dialog opens but states why it cannot
 * import instead of offering controls.
 */
export function BrowserCookieImportDialog({
  open,
  onOpenChange,
  backend,
  sessionId,
  currentHost,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  backend: BrowserBackend
  /** Local runtime session receiving the cookies (`local-chromium` / `user-chrome`). */
  sessionId?: string
  /** Public host the page is showing; enables the "this site" scope. */
  currentHost?: string | null
  /** Called after a successful import (e.g. to reload the page) before the dialog closes. */
  onImported?: (result: ImportResult) => void | Promise<void>
}) {
  const t = useTranslations("browserVault.cookieImport")
  const featureEnabled = useSettingsStore(
    (state) => state.settings?.browserCookieImportEnabled ?? false
  )
  const [consented, setConsented] = useState(readConsent)
  const sink = cookieSinkFor(backend)

  const grantConsent = () => {
    window.localStorage.setItem(COOKIE_IMPORT_CONSENT_STORAGE_KEY, "1")
    setConsented(true)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {!sink ? (
          <p
            role="status"
            data-testid="cookie-import-inert"
            className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
          >
            {t("sink.unsupported")}
          </p>
        ) : !featureEnabled ? (
          <div
            role="status"
            data-testid="cookie-import-disabled"
            className="flex flex-col items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
          >
            <p>{t("featureDisabled")}</p>
            <Button asChild size="sm" variant="outline">
              <Link href={DESKTOP_SETTINGS_HREF} onClick={() => onOpenChange(false)}>
                {t("openSettings")}
              </Link>
            </Button>
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
          <ImportForm
            sink={sink}
            sessionId={sessionId}
            currentHost={currentHost}
            onDone={() => onOpenChange(false)}
            onImported={onImported}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
