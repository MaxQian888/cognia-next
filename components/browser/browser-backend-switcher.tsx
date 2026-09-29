"use client"

/**
 * The browser pane's engine switch (ADR-0201): built-in preview, local
 * Chromium, your own Chrome, or the cloud browser.
 *
 * The switch shows the engine the user CHOSE, not only the one that is
 * running: choosing local Chromium before it is installed is how the install
 * is offered, and choosing "your Chrome" while remote debugging is off is how
 * the user learns to turn it on. Until the choice can be served the pane keeps
 * running the fallback `resolveDesktopBackend` picked.
 */

import { CheckIcon, CopyIcon, DownloadIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import type { LocalBrowserState } from "@/hooks/browser/use-local-browser"
import type { BrowserBackend, BrowserBackendDecision } from "@/lib/browser/backend-availability"
import type { UserChromeCandidate } from "@/lib/browser/local-client"
import { formatBytes } from "@/lib/storage/usage"
import { writeClipboardText } from "@/lib/tauri/clipboard"

/** Where Chrome 144+ lets the user enable remote debugging for itself. */
export const CHROME_REMOTE_DEBUGGING_URL = "chrome://inspect/#remote-debugging"

type SelectableBackend = Exclude<BrowserBackend, "web-fallback">

/** The option the switch shows: an explicit choice wins over the fallback. */
export function selectedBackend(
  decision: BrowserBackendDecision,
  preference: BrowserBackend | null
): SelectableBackend {
  if (preference && preference !== "web-fallback") return preference
  return decision.backend === "web-fallback" ? "embedded" : decision.backend
}

/** The candidate to attach: the one asked for, else the first usable one. */
export function pickUserChromeCandidate(
  candidates: UserChromeCandidate[],
  browser: string | null
): UserChromeCandidate | null {
  return (
    candidates.find((candidate) => candidate.browser === browser) ??
    candidates.find((candidate) => candidate.available) ??
    candidates.find((candidate) => candidate.reason !== "not_installed") ??
    null
  )
}

export interface BrowserBackendSwitcherProps {
  decision: BrowserBackendDecision
  preference: BrowserBackend | null
  onPreferenceChange: (backend: BrowserBackend) => void
  local: LocalBrowserState
  userChromeBrowser: string | null
  onUserChromeBrowserChange: (browser: string) => void
}

export function BrowserBackendSwitcher({
  decision,
  preference,
  onPreferenceChange,
  local,
  userChromeBrowser,
  onUserChromeBrowserChange,
}: BrowserBackendSwitcherProps) {
  const t = useTranslations("browserLocal.backend")
  const [copied, setCopied] = useState(false)
  const selected = selectedBackend(decision, preference)
  const installed = local.status?.installed ?? false
  const installedCandidates = local.userChrome.filter(
    (candidate) => candidate.reason !== "not_installed"
  )
  const candidate = pickUserChromeCandidate(local.userChrome, userChromeBrowser)
  const showRemote = decision.remoteReachable || selected === "remote"

  const copyInspectUrl = async () => {
    try {
      await writeClipboardText(CHROME_REMOTE_DEBUGGING_URL)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="browser-backend-switcher">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("label")}</span>
        <NativeSelect
          value={selected}
          onChange={(event) => onPreferenceChange(event.target.value as BrowserBackend)}
          aria-label={t("label")}
          size="sm"
          wrapperClassName="w-full"
          className="h-7 text-xs"
        >
          <NativeSelectOption value="embedded">{t("embedded")}</NativeSelectOption>
          {local.supported && (
            <NativeSelectOption value="local-chromium">
              {installed ? t("localChromium") : t("localChromiumMissing")}
            </NativeSelectOption>
          )}
          {local.supported && (
            <NativeSelectOption value="user-chrome">
              {decision.userChromeReachable ? t("userChrome") : t("userChromeUnavailable")}
            </NativeSelectOption>
          )}
          {showRemote && <NativeSelectOption value="remote">{t("remote")}</NativeSelectOption>}
        </NativeSelect>
      </div>

      {selected === "local-chromium" && !installed && <LocalChromiumInstall local={local} />}

      {selected === "user-chrome" && (
        <div className="flex flex-col gap-1.5 text-xs" data-testid="browser-user-chrome">
          {installedCandidates.length === 0 ? (
            <p className="text-muted-foreground">{t("userChromeNone")}</p>
          ) : (
            <>
              {installedCandidates.length > 1 && (
                <NativeSelect
                  value={candidate?.browser ?? ""}
                  onChange={(event) => onUserChromeBrowserChange(event.target.value)}
                  aria-label={t("userChromeBrowser")}
                  size="sm"
                  wrapperClassName="w-full"
                  className="h-7 text-xs"
                >
                  {installedCandidates.map((entry) => (
                    <NativeSelectOption key={entry.browser} value={entry.browser}>
                      {entry.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
              {candidate?.reason === "remote_debugging_disabled" && (
                <div className="space-y-1.5" role="status">
                  <p className="text-muted-foreground">
                    {t("userChromeDisabled", {
                      browser: candidate.label,
                      url: CHROME_REMOTE_DEBUGGING_URL,
                    })}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => void copyInspectUrl()}
                    >
                      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                      {copied ? t("copied") : t("copyInspectUrl")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => void local.discoverUserChrome()}
                    >
                      <RefreshCwIcon className="size-3" />
                      {t("recheck")}
                    </Button>
                  </div>
                </div>
              )}
              {candidate?.reason === "not_installed" && (
                <p className="text-muted-foreground">
                  {t("userChromeNotInstalled", { browser: candidate.label })}
                </p>
              )}
              {candidate?.available && (
                <p className="text-muted-foreground">{t("userChromeConsent")}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Install Chromium, with live progress from `browser-local://install`. */
export function LocalChromiumInstall({ local }: { local: LocalBrowserState }) {
  const t = useTranslations("browserLocal.backend")
  const progress = local.progress
  if (local.status && !local.status.runtimeStaged) {
    return <p className="text-xs text-muted-foreground">{t("runtimeMissing")}</p>
  }
  const installing = local.busy || local.status?.installing || progress?.phase === "downloading"
  const percent =
    progress?.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round(((progress.receivedBytes ?? 0) / progress.totalBytes) * 100))
      : null
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="browser-chromium-install">
      <p className="text-muted-foreground">{t("chromiumHint")}</p>
      {installing || progress?.phase === "extracting" ? (
        <div className="space-y-1" role="status" aria-live="polite">
          <p className="flex items-center gap-1.5 font-medium">
            <Loader2Icon className="size-3 animate-spin" aria-hidden />
            {t("installing")}
          </p>
          {percent !== null && (
            <Progress value={percent} className="h-1" aria-label={t("install")} />
          )}
          <p className="text-muted-foreground">
            {progress?.phase === "extracting"
              ? t("installExtracting")
              : progress?.totalBytes
                ? t("installProgress", {
                    received: formatBytes(progress.receivedBytes ?? 0),
                    total: formatBytes(progress.totalBytes),
                  })
                : t("installProgressUnknown", {
                    received: formatBytes(progress?.receivedBytes ?? 0),
                  })}
          </p>
        </div>
      ) : (
        <Button size="sm" className="h-7 self-start text-xs" onClick={() => void local.install()}>
          <DownloadIcon className="size-3" />
          {t("install")}
        </Button>
      )}
      {progress?.phase === "done" && <p className="text-muted-foreground">{t("installDone")}</p>}
      {(progress?.phase === "failed" || local.error) && (
        <p className="text-destructive" role="alert">
          {t("installFailed", { message: progress?.message ?? local.error ?? "" })}
        </p>
      )}
    </div>
  )
}
