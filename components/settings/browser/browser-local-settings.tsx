"use client"

/**
 * Settings → Desktop → Browser (ADR-0201): the pane's default engine, the
 * managed Chromium (install / uninstall / status), where downloads go, where
 * the Chromium profile lives, and the entry points to the password vault and
 * the extension manager.
 *
 * The extension and sign-in counts are read from their Dexie mirrors so they
 * paint immediately, then refreshed from Rust (the owner) whenever this block
 * mounts; the mirrors are replaced wholesale with what Rust returned.
 */

import { GlobeIcon, FolderOpenIcon, KeyRoundIcon, PuzzleIcon, Trash2Icon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { LocalChromiumInstall } from "@/components/browser/browser-backend-switcher"
import { BrowserExtensionsPanel } from "@/components/browser/extensions/browser-extensions-panel"
import { BrowserPasswordManager } from "@/components/browser/vault/browser-password-manager"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import { setLocalChromiumInstalled } from "@/lib/browser/agent-engine"
import {
  chooseDownloadsDir,
  getDownloadsDir,
  resetDownloadsDir,
  setAskWhereToSave,
  type BrowserDownloadsDir,
} from "@/lib/browser/downloads-client"
import { listExtensions } from "@/lib/browser/extensions-client"
import { listCredentials } from "@/lib/browser/passwords"
import {
  listBrowserCredentialMeta,
  listBrowserExtensionMirror,
  replaceBrowserCredentialMeta,
  replaceBrowserExtensionMirror,
} from "@/lib/db/browser-mirrors"
import { isTauri } from "@/lib/tauri"
import { revealInExplorer } from "@/lib/tauri/opener"
import { useSettingsStore } from "@/stores/settings/settings-store"

type DefaultBackend = "auto" | "embedded" | "local-chromium" | "user-chrome" | "remote"
type UserChromeBrowserSetting = "chrome" | "chrome-beta" | "chrome-canary" | "edge" | "brave"

const DEFAULT_BACKENDS: DefaultBackend[] = [
  "auto",
  "embedded",
  "local-chromium",
  "user-chrome",
  "remote",
]

/** The Cognia Chromium profile, relative to the app-data directory (ADR-0201). */
export const BROWSER_PROFILE_SEGMENTS = ["browser", "profiles", "default"] as const

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error)
}

export function BrowserLocalSettings({ desktop = isTauri() }: { desktop?: boolean }) {
  const t = useTranslations("browserLocal.settings")
  const tBackend = useTranslations("browserLocal.backend")
  const defaultBackend =
    (useSettingsStore((state) => state.settings?.browserDefaultBackend) as
      DefaultBackend | undefined) ?? "auto"
  const userChromeBrowser = useSettingsStore(
    (state) => state.settings?.browserUserChromeBrowser ?? null
  )
  const save = useSettingsStore((state) => state.save)
  const local = useLocalBrowser({ enabled: desktop })
  const [dir, setDir] = useState<BrowserDownloadsDir | null>(null)
  const [profilePath, setProfilePath] = useState<string | null>(null)
  const [passwordsOpen, setPasswordsOpen] = useState(false)
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  // Agent routing reads the install state synchronously; an install or
  // uninstall from here must reach it without waiting for a browser pane.
  useEffect(() => {
    if (local.status) setLocalChromiumInstalled(local.status.installed)
  }, [local.status])
  const extensions = useLiveQuery(() => listBrowserExtensionMirror(), [], [])
  const credentials = useLiveQuery(() => listBrowserCredentialMeta(), [], [])

  // The load runs once per mount; `t` is read through a ref so a new
  // translator identity never re-fetches, and `dirChosen` keeps a slow first
  // read from overwriting a folder the user already picked.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const dirChosen = useRef(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void getDownloadsDir()
      .then((next) => {
        if (!cancelled && !dirChosen.current) setDir(next)
      })
      .catch(() => {
        if (!cancelled) toast.error(tRef.current("downloads.loadFailed"))
      })
    void import("@tauri-apps/api/path")
      .then(async (path) => path.join(await path.appDataDir(), ...BROWSER_PROFILE_SEGMENTS))
      .then((next) => {
        if (!cancelled) setProfilePath(next)
      })
      .catch(() => undefined)
    // Refresh the metadata mirrors from Rust, their owner.
    void listExtensions()
      .then((list) => replaceBrowserExtensionMirror(list))
      .catch(() => undefined)
    void listCredentials()
      .then((list) => replaceBrowserCredentialMeta(list))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [desktop])

  // Every change goes through Rust: the folder is picked in a native picker
  // Rust shows, so the renderer never names a path (ADR-0201).
  const updateDir = useCallback(
    async (work: () => Promise<BrowserDownloadsDir | null>) => {
      try {
        const next = await work()
        if (next) {
          dirChosen.current = true
          setDir(next)
        }
      } catch (error) {
        toast.error(
          errorText(error).includes("downloads_dir_forbidden")
            ? t("downloads.forbidden")
            : t("downloads.saveFailed")
        )
      }
    },
    [t]
  )

  const chooseDir = () => updateDir(() => chooseDownloadsDir(dir?.askWhereToSave ?? false))

  const uninstall = async () => {
    const ok = await local.uninstall()
    if (ok) toast.success(t("chromium.uninstalled"))
    else toast.error(t("chromium.uninstallFailed", { message: local.error ?? "" }))
  }

  if (!desktop) {
    return (
      <SettingsBlock
        icon={<GlobeIcon />}
        title={t("title")}
        description={t("description")}
        testid="browser-local-settings"
        settingId="desktop-browser"
      >
        <p className="text-xs text-muted-foreground">{t("webOnly")}</p>
      </SettingsBlock>
    )
  }

  const installed = local.status?.installed ?? false
  const installedCandidates = local.userChrome.filter(
    (candidate) => candidate.reason !== "not_installed"
  )

  return (
    <SettingsBlock
      icon={<GlobeIcon />}
      title={t("title")}
      description={t("description")}
      testid="browser-local-settings"
      settingId="desktop-browser"
      contentClassName="space-y-5"
    >
      <section className="space-y-2">
        <Label htmlFor="browser-default-backend">{t("defaultBackend")}</Label>
        <NativeSelect
          id="browser-default-backend"
          value={defaultBackend}
          onChange={(event) =>
            void save({ browserDefaultBackend: event.target.value as DefaultBackend })
          }
          size="sm"
          wrapperClassName="w-full max-w-xs"
        >
          {DEFAULT_BACKENDS.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value === "auto"
                ? tBackend("auto")
                : value === "embedded"
                  ? tBackend("embedded")
                  : value === "local-chromium"
                    ? tBackend("localChromium")
                    : value === "user-chrome"
                      ? tBackend("userChrome")
                      : tBackend("remote")}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">{t("defaultBackendHint")}</p>
        {defaultBackend === "user-chrome" && installedCandidates.length > 0 && (
          <NativeSelect
            value={userChromeBrowser ?? installedCandidates[0]?.browser ?? ""}
            onChange={(event) =>
              void save({
                browserUserChromeBrowser: event.target.value as UserChromeBrowserSetting,
              })
            }
            aria-label={tBackend("userChromeBrowser")}
            size="sm"
            wrapperClassName="w-full max-w-xs"
          >
            {installedCandidates.map((candidate) => (
              <NativeSelectOption key={candidate.browser} value={candidate.browser}>
                {candidate.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </section>

      <section className="space-y-2 border-t pt-4" aria-labelledby="browser-chromium-heading">
        <div className="flex items-center justify-between gap-3">
          <h4 id="browser-chromium-heading" className="text-sm font-medium">
            {t("chromium.title")}
          </h4>
          <Badge
            variant={installed ? "secondary" : "outline"}
            data-testid="browser-chromium-status"
          >
            {installed
              ? local.status?.chromiumVersion
                ? t("chromium.installed", { version: local.status.chromiumVersion })
                : t("chromium.installedNoVersion")
              : t("chromium.notInstalled")}
          </Badge>
        </div>
        {installed ? (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={local.busy}
            onClick={() => void uninstall()}
          >
            <Trash2Icon className="size-3.5" />
            {t("chromium.uninstall")}
          </Button>
        ) : (
          <LocalChromiumInstall local={local} />
        )}
      </section>

      <section className="space-y-3 border-t pt-4" aria-labelledby="browser-downloads-heading">
        <h4 id="browser-downloads-heading" className="text-sm font-medium">
          {t("downloads.title")}
        </h4>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("downloads.folder")}</Label>
          <div className="flex min-w-0 items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs"
              data-testid="browser-downloads-dir"
              title={dir?.path}
            >
              {dir?.path ?? ""}
            </code>
            {dir?.isDefault && <Badge variant="outline">{t("downloads.defaultBadge")}</Badge>}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => void chooseDir()} disabled={!dir}>
              {t("downloads.change")}
            </Button>
            {dir && !dir.isDefault && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void updateDir(() => resetDownloadsDir())}
              >
                {t("downloads.reset")}
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="browser-ask-where">{t("downloads.askWhereToSave")}</Label>
          <Switch
            id="browser-ask-where"
            checked={dir?.askWhereToSave ?? false}
            disabled={!dir}
            onCheckedChange={(checked) => dir && void updateDir(() => setAskWhereToSave(checked))}
          />
        </div>
      </section>

      <section className="space-y-2 border-t pt-4" aria-labelledby="browser-profile-heading">
        <h4 id="browser-profile-heading" className="text-sm font-medium">
          {t("profile.title")}
        </h4>
        <p className="text-xs text-muted-foreground">{t("profile.description")}</p>
        {profilePath && (
          <div className="flex min-w-0 items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs"
              data-testid="browser-profile-path"
              title={profilePath}
            >
              {profilePath}
            </code>
            <Button
              size="sm"
              variant="outline"
              disabled={!installed}
              onClick={() =>
                void revealInExplorer(profilePath).catch((error: unknown) =>
                  toast.error(t("profile.revealFailed", { message: errorText(error) }))
                )
              }
            >
              <FolderOpenIcon className="size-3.5" />
              {t("profile.reveal")}
            </Button>
          </div>
        )}
      </section>

      <section className="grid gap-3 border-t pt-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <KeyRoundIcon className="size-3.5" aria-hidden />
            {t("passwords.title")}
          </h4>
          <p className="text-xs text-muted-foreground">{t("passwords.description")}</p>
          <p className="text-xs" data-testid="browser-passwords-count">
            {t("passwords.count", { count: credentials.length })}
          </p>
          <Button size="sm" variant="outline" onClick={() => setPasswordsOpen(true)}>
            {t("passwords.manage")}
          </Button>
        </div>
        <div className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <PuzzleIcon className="size-3.5" aria-hidden />
            {t("extensions.title")}
          </h4>
          <p className="text-xs text-muted-foreground">{t("extensions.description")}</p>
          <p className="text-xs" data-testid="browser-extensions-count">
            {t("extensions.count", { count: extensions.length })}
          </p>
          <Button size="sm" variant="outline" onClick={() => setExtensionsOpen(true)}>
            {t("extensions.manage")}
          </Button>
        </div>
      </section>

      <Dialog
        open={passwordsOpen}
        onOpenChange={(open) => {
          setPasswordsOpen(open)
          // The manager may have added or removed sign-ins; re-mirror.
          if (!open)
            void listCredentials()
              .then((list) => replaceBrowserCredentialMeta(list))
              .catch(() => undefined)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("passwords.title")}</DialogTitle>
            <DialogDescription>{t("passwords.description")}</DialogDescription>
          </DialogHeader>
          <BrowserPasswordManager />
        </DialogContent>
      </Dialog>
      <Dialog
        open={extensionsOpen}
        onOpenChange={(open) => {
          setExtensionsOpen(open)
          if (!open)
            void listExtensions()
              .then((list) => replaceBrowserExtensionMirror(list))
              .catch(() => undefined)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("extensions.title")}</DialogTitle>
            <DialogDescription>{t("extensions.description")}</DialogDescription>
          </DialogHeader>
          <BrowserExtensionsPanel backend="local-chromium" />
        </DialogContent>
      </Dialog>
    </SettingsBlock>
  )
}
