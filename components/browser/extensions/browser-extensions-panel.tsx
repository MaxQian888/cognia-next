"use client"

import {
  ExternalLinkIcon,
  FolderOpenIcon,
  PackageIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import {
  cancelExtensionInstall,
  checkExtensionUpdates,
  confirmExtensionInstall,
  listExtensions,
  pickCrxExtension,
  pickUnpackedExtension,
  prepareWebStoreExtension,
  removeExtension,
  setExtensionEnabled,
  updateExtension,
  browserExtensionErrorCode,
  type BrowserExtension,
  type PendingExtensionInstall,
} from "@/lib/browser/extensions-client"
import { localBrowser } from "@/lib/browser/local-client"

/**
 * Why the panel is inert on a backend, or `null` when extensions are live.
 *
 * Intentionally dormant (CLAUDE.md rule 7): only Cognia's local Chromium loads
 * the extension store. The embedded webview has no extension runtime
 * (`extensions_unsupported_backend`), the user's own Chrome keeps its own set,
 * and the cloud browser runs on another machine. On those backends the panel
 * still lists what is installed, read-only, beside a stated reason.
 */
export function extensionsInertReason(
  backend: BrowserBackend
): "embedded" | "userChrome" | "remote" | null {
  switch (backend) {
    case "local-chromium":
      return null
    case "embedded":
      return "embedded"
    case "user-chrome":
      return "userChrome"
    default:
      return "remote"
  }
}

type Busy = { id: string } | { install: "webstore" | "crx" | "unpacked" } | null

/**
 * Chrome extension management for the local Chromium browser (ADR-0201):
 * install from the Web Store (id or URL), a `.crx` file or an unpacked folder,
 * enable/disable, remove, check for and apply updates, and open an extension's
 * popup or options page as a tab in the current local session.
 *
 * Every install is confirmed: Rust verifies the package (the file or folder is
 * picked in a native dialog Rust shows) and returns its permissions and host
 * permissions; the panel lists them and installs only when the user agrees.
 */
export function BrowserExtensionsPanel({
  backend,
  sessionId,
}: {
  backend: BrowserBackend
  /** Local runtime session used to open popups / options pages. */
  sessionId?: string
}) {
  const t = useTranslations("browserVault.extensions")
  const inert = extensionsInertReason(backend)
  const [extensions, setExtensions] = useState<BrowserExtension[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [webstoreInput, setWebstoreInput] = useState("")
  const [busy, setBusy] = useState<Busy>(null)
  const [checking, setChecking] = useState(false)
  const [updates, setUpdates] = useState<Record<string, string>>({})
  const [pendingRemove, setPendingRemove] = useState<BrowserExtension | null>(null)
  const [pendingInstall, setPendingInstall] = useState<{
    kind: "webstore" | "crx" | "unpacked"
    install: PendingExtensionInstall
  } | null>(null)
  const [unsupportedByHost, setUnsupportedByHost] = useState(false)

  const refresh = useCallback(() => {
    let current = true
    listExtensions()
      .then((next) => {
        if (!current) return
        setExtensions(next)
        setLoadFailed(false)
      })
      .catch(() => {
        if (current) setLoadFailed(true)
      })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => refresh(), [refresh])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    localBrowser
      .onEvent((event: unknown) => {
        if (
          event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "extensions.changed"
        ) {
          refresh()
        }
      })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refresh])

  const reportError = (error: unknown) => {
    const code = browserExtensionErrorCode(error)
    if (code === "extensions_unsupported_backend") setUnsupportedByHost(true)
    toast.error(code ? t(`errors.${code}`) : t("failed"))
  }

  const upsert = (extension: BrowserExtension) =>
    setExtensions((current) => [
      ...(current ?? []).filter((item) => item.id !== extension.id),
      extension,
    ])

  /** Step one: Rust fetches / picks and verifies the package; nothing is installed yet. */
  const prepare = async (
    kind: "webstore" | "crx" | "unpacked",
    run: () => Promise<PendingExtensionInstall | null>
  ) => {
    if (busy) return
    setBusy({ install: kind })
    try {
      const pending = await run()
      if (pending) setPendingInstall({ kind, install: pending })
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  /** Step two: the user accepted the permissions. */
  const confirmInstall = async () => {
    const target = pendingInstall
    setPendingInstall(null)
    if (!target) return
    setBusy({ install: target.kind })
    try {
      const installed = await confirmExtensionInstall(target.install.pendingId)
      upsert(installed)
      toast.success(t("install.done", { name: installed.name }))
      if (target.kind === "webstore") setWebstoreInput("")
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  const declineInstall = () => {
    const target = pendingInstall
    setPendingInstall(null)
    if (target) void cancelExtensionInstall(target.install.pendingId).catch(() => undefined)
  }

  const submitWebstore = (event: FormEvent) => {
    event.preventDefault()
    const value = webstoreInput.trim()
    if (!value) return
    void prepare("webstore", () => prepareWebStoreExtension(value))
  }

  const withExtension = async (
    extension: BrowserExtension,
    run: () => Promise<BrowserExtension | void>,
    success?: string
  ) => {
    if (busy) return
    setBusy({ id: extension.id })
    try {
      const next = await run()
      if (next) upsert(next)
      if (success) toast.success(success)
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(null)
    }
  }

  const toggle = (extension: BrowserExtension, enabled: boolean) =>
    void withExtension(extension, () => setExtensionEnabled(extension.id, enabled))

  const update = (extension: BrowserExtension, version: string) =>
    void withExtension(
      extension,
      async () => {
        const next = await updateExtension(extension.id)
        setUpdates((current) => {
          const rest = { ...current }
          delete rest[extension.id]
          return rest
        })
        return next
      },
      t("updated", { name: extension.name, version })
    )

  const confirmRemove = () => {
    const target = pendingRemove
    setPendingRemove(null)
    if (!target) return
    void withExtension(
      target,
      async () => {
        await removeExtension(target.id)
        setExtensions((current) => (current ?? []).filter((item) => item.id !== target.id))
      },
      t("removed", { name: target.name })
    )
  }

  const checkUpdates = async () => {
    if (checking) return
    setChecking(true)
    try {
      const available = await checkExtensionUpdates()
      setUpdates(Object.fromEntries(available.map((item) => [item.id, item.availableVersion])))
      if (available.length === 0) toast.info(t("noUpdates"))
      else toast.info(t("updatesAvailable", { count: available.length }))
    } catch (error) {
      reportError(error)
    } finally {
      setChecking(false)
    }
  }

  const openPage = async (extension: BrowserExtension, page: "popup" | "options") => {
    const path = page === "popup" ? extension.popupPath : extension.optionsPath
    if (!sessionId || !path) return
    try {
      await localBrowser.rpc("browser.extension.open", {
        sessionId,
        extensionId: extension.id,
        page,
        path,
      })
    } catch (error) {
      reportError(error)
    }
  }

  const inertMessage = inert
    ? t(`unsupported.${inert}`)
    : unsupportedByHost
      ? t("errors.extensions_unsupported_backend")
      : null
  const effectiveInert = inertMessage !== null
  const sorted = [...(extensions ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const installing = busy && "install" in busy ? busy.install : null

  return (
    <section
      aria-labelledby="browser-extensions-title"
      className="grid gap-4"
      data-inert={effectiveInert ? "true" : undefined}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="browser-extensions-title" className="text-base font-semibold">
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {!effectiveInert && (
          <Button
            size="sm"
            variant="outline"
            disabled={checking || !extensions?.length}
            onClick={() => void checkUpdates()}
          >
            {checking ? <Spinner /> : <RefreshCwIcon />}
            {checking ? t("checking") : t("checkUpdates")}
          </Button>
        )}
      </header>

      {effectiveInert && (
        <Alert role="status" data-testid="browser-extensions-inert">
          <PuzzleIcon />
          <AlertTitle>{t("unsupported.title")}</AlertTitle>
          <AlertDescription>{inertMessage}</AlertDescription>
        </Alert>
      )}

      {!effectiveInert && (
        <div className="grid gap-2">
          <form className="flex flex-wrap gap-2" onSubmit={submitWebstore}>
            <Input
              aria-label={t("install.label")}
              placeholder={t("install.placeholder")}
              value={webstoreInput}
              onChange={(event) => setWebstoreInput(event.target.value)}
              className="min-w-48 flex-1"
            />
            <Button type="submit" size="sm" disabled={!webstoreInput.trim() || busy !== null}>
              {installing === "webstore" ? t("install.installing") : t("install.webstore")}
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void prepare("crx", () => pickCrxExtension())}
            >
              <PackageIcon />
              {installing === "crx" ? t("install.installing") : t("install.crx")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void prepare("unpacked", () => pickUnpackedExtension())}
            >
              <FolderOpenIcon />
              {installing === "unpacked" ? t("install.installing") : t("install.unpacked")}
            </Button>
          </div>
        </div>
      )}

      {loadFailed ? (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm">
          <span className="text-destructive">{t("loadFailed")}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              refresh()
            }}
          >
            <RefreshCwIcon />
            {t("retry")}
          </Button>
        </div>
      ) : extensions === null ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </p>
      ) : sorted.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {sorted.map((extension) => {
            const rowBusy = busy !== null && "id" in busy && busy.id === extension.id
            const available = updates[extension.id] ?? extension.updateAvailable ?? null
            return (
              <li key={extension.id} className="grid gap-2 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium">{extension.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("version", { version: extension.version })}
                    </p>
                    {extension.description && (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {extension.description}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Badge variant="secondary">{t(`source.${extension.source}`)}</Badge>
                      <Badge variant="outline">
                        {t("permissions", { count: extension.permissions.length })}
                      </Badge>
                      {extension.hostPermissions.length > 0 && (
                        <Badge variant="outline">
                          {t("hostPermissions", { count: extension.hostPermissions.length })}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Switch
                    checked={extension.enabled}
                    disabled={effectiveInert || rowBusy}
                    aria-label={
                      extension.enabled
                        ? t("disable", { name: extension.name })
                        : t("enable", { name: extension.name })
                    }
                    onCheckedChange={(checked) => toggle(extension, checked)}
                  />
                </div>
                {!effectiveInert && (
                  <div className="flex flex-wrap items-center gap-2">
                    {extension.popupPath && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!sessionId || !extension.enabled}
                        title={sessionId ? undefined : t("openRequiresSession")}
                        onClick={() => void openPage(extension, "popup")}
                      >
                        <ExternalLinkIcon />
                        {t("openPopup")}
                      </Button>
                    )}
                    {extension.optionsPath && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!sessionId || !extension.enabled}
                        title={sessionId ? undefined : t("openRequiresSession")}
                        onClick={() => void openPage(extension, "options")}
                      >
                        <SettingsIcon />
                        {t("openOptions")}
                      </Button>
                    )}
                    {available && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rowBusy}
                        onClick={() => update(extension, available)}
                      >
                        {t("update", { version: available })}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto text-destructive hover:text-destructive"
                      disabled={rowBusy}
                      onClick={() => setPendingRemove(extension)}
                    >
                      <Trash2Icon />
                      {t("remove")}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!effectiveInert &&
        !sessionId &&
        sorted.some((item) => item.popupPath || item.optionsPath) && (
          <p className="text-xs text-muted-foreground">{t("openRequiresSession")}</p>
        )}

      <AlertDialog
        open={pendingInstall !== null}
        onOpenChange={(open) => {
          if (!open) declineInstall()
        }}
      >
        <AlertDialogContent data-testid="browser-extension-install-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("installConfirm.title", { name: pendingInstall?.install.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("installConfirm.description", {
                version: pendingInstall?.install.version ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingInstall && (
            <div className="grid gap-3 text-sm">
              {pendingInstall.install.permissions.length === 0 &&
              pendingInstall.install.hostPermissions.length === 0 ? (
                <p className="text-muted-foreground">{t("installConfirm.none")}</p>
              ) : (
                <>
                  {pendingInstall.install.permissions.length > 0 && (
                    <div className="grid gap-1">
                      <p className="font-medium">{t("installConfirm.permissions")}</p>
                      <ul
                        aria-label={t("installConfirm.permissions")}
                        className="flex flex-wrap gap-1.5"
                      >
                        {pendingInstall.install.permissions.map((permission) => (
                          <li key={permission}>
                            <Badge variant="outline" className="font-mono">
                              {permission}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {pendingInstall.install.hostPermissions.length > 0 && (
                    <div className="grid gap-1">
                      <p className="font-medium">{t("installConfirm.hostPermissions")}</p>
                      <ul
                        aria-label={t("installConfirm.hostPermissions")}
                        className="flex flex-wrap gap-1.5"
                      >
                        {pendingInstall.install.hostPermissions.map((host) => (
                          <li key={host}>
                            <Badge variant="outline" className="font-mono">
                              {host === "<all_urls>" ? t("installConfirm.allSites") : host}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmInstall()}>
              {t("installConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeConfirm.description", { name: pendingRemove?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>
              {t("removeConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
