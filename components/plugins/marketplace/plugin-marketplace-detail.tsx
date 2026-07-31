"use client"

// Sheet shown when the user clicks a marketplace card. Surfaces README
// (if the registry returned it), the full permission request preview
// (highlighting dangerous permissions), the dependency list, and a single
// install / uninstall CTA.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CodeIcon, ExternalLinkIcon } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { InstallButton } from "../_shared/install-button"
import { PluginVersionBadge } from "../_shared/plugin-version-badge"
import { PluginDependencyPanel } from "../_shared/plugin-dependency-panel"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import type { PluginManifest } from "@/types/plugin"
import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
} from "@/lib/plugin/security/permission-guard"
import type { PluginPermission } from "@/types/plugin"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginSourceBadge } from "../plugin-source-badge"
import type {
  MarketplaceClient,
  PluginMarketplaceEntry,
} from "@/hooks/plugins/use-plugin-marketplace"
import { loadPluginMarketplaceClient } from "@/hooks/plugins/use-plugin-marketplace"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface DetailEntry extends PluginMarketplaceEntry {
  capabilities?: string[]
  permissions?: PluginPermission[]
  optionalPermissions?: PluginPermission[]
  dependencies?: Record<string, string>
  signatureState?: SignatureState
  homepage?: string
  repository?: string
  readme?: string
  license?: string
  /** Full manifest, when already known. Otherwise fetched from the registry
   *  on open so the "View raw manifest" viewer can render it. */
  manifest?: PluginManifest
}

interface Props {
  open: boolean
  entry: DetailEntry | null
  installed: boolean
  installing: boolean
  onClose: () => void
  onInstall: (id: string, version?: string) => void
  onUninstall: (id: string) => void
}

export function PluginMarketplaceDetail({
  open,
  entry,
  installed,
  installing,
  onClose,
  onInstall,
  onUninstall,
}: Props) {
  const t = useTranslations("plugins.marketplaceDetail")

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {/* Width unified to `lg:max-w-3xl` to match the marketplace-sheet
       *  audit recommendation; the old `sm:max-w-2xl` band caused a
       *  visible jump when transitioning between widths on tablets. */}
      <SheetContent className="w-full lg:max-w-3xl overflow-y-auto">
        {entry ? (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <SheetTitle className="flex-1 min-w-0 flex items-center gap-2">
                  <span>{entry.name}</span>
                  <PluginVersionBadge version={entry.version} />
                </SheetTitle>
                {entry.source === "builtin" && <PluginSourceBadge source="builtin" />}
                <PluginSignatureBadge
                  state={entry.signatureState ?? (entry.signed ? "verified" : "unverified")}
                  signer={entry.author}
                />
              </div>
              {entry.description && <SheetDescription>{entry.description}</SheetDescription>}
            </SheetHeader>

            <div className="space-y-4 mt-4">
              <RawManifestSection entry={entry} />
              <MetaCard entry={entry} />

              {entry.permissions && entry.permissions.length > 0 && (
                <PermissionList title={t("declared")} permissions={entry.permissions} />
              )}
              {entry.optionalPermissions && entry.optionalPermissions.length > 0 && (
                <PermissionList title={t("optional")} permissions={entry.optionalPermissions} />
              )}

              <PluginDependencyPanel
                manifest={{ dependencies: entry.dependencies } as PluginManifest}
              />

              {entry.readme && (
                <Card className="p-3">
                  <div className="text-xs font-semibold mb-2">{t("readme")}</div>
                  <ScrollArea className="max-h-[40vh]">
                    <div className="text-sm pr-2">
                      <MarkdownRenderer
                        content={entry.readme}
                        enableMermaid={false}
                        enableMath={false}
                        rhythm="document"
                      />
                    </div>
                  </ScrollArea>
                </Card>
              )}
            </div>

            <SheetFooter className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              {entry.source === "builtin" ? (
                <PluginSourceBadge source="builtin" />
              ) : (
                <InstallSection
                  entry={entry}
                  installed={installed}
                  installing={installing}
                  onInstall={onInstall}
                  onUninstall={onUninstall}
                />
              )}
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

/**
 * Renders the version dropdown (when the registry exposes versions)
 * alongside the install / uninstall button so the user can downgrade
 * or pin a specific release. Falls back to the entry's `version` field
 * when the registry doesn't return a list (web / degraded mode).
 */
function InstallSection({
  entry,
  installed,
  installing,
  onInstall,
  onUninstall,
}: {
  entry: DetailEntry
  installed: boolean
  installing: boolean
  onInstall: (id: string, version?: string) => void
  onUninstall: (id: string) => void
}) {
  const t = useTranslations("plugins.marketplaceDetail")
  const [versions, setVersions] = useState<string[]>([entry.version])
  const [selected, setSelected] = useState<string>(entry.version)

  // Reset internal version state when the entry changes via the React 19
  // "compare prev during render" pattern (so we don't trip
  // `react-hooks/set-state-in-effect`). The async fetch still lives in
  // an effect because that's I/O.
  const entryKey = `${entry.id}@${entry.version}`
  const [trackedEntry, setTrackedEntry] = useState(entryKey)
  if (trackedEntry !== entryKey) {
    setTrackedEntry(entryKey)
    setVersions([entry.version])
    setSelected(entry.version)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const client: MarketplaceClient = await loadPluginMarketplaceClient()
        if (!client.getVersions) return
        const list = await client.getVersions(entry.id)
        if (cancelled) return
        const names = list.map((v) => v.version).filter((v): v is string => typeof v === "string")
        if (names.length === 0) return
        // Surface the entry's `version` field at the top if the registry
        // omitted it (latest is usually first in the response).
        const merged = names.includes(entry.version) ? names : [entry.version, ...names]
        setVersions(merged)
        setSelected(entry.version)
      } catch {
        // best-effort — fall back to the entry's own version field
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry.id, entry.version])

  if (installed) {
    return (
      <InstallButton
        installed
        installing={installing}
        onInstall={() => onInstall(entry.id, selected)}
        onUninstall={() => onUninstall(entry.id)}
        installLabel={t("install")}
        installingLabel={t("installing")}
        uninstallLabel={t("uninstall")}
        uninstallingLabel={t("uninstalling")}
      />
    )
  }

  return (
    <>
      {versions.length > 1 && (
        <Select value={selected} onValueChange={setSelected} disabled={installing}>
          <SelectTrigger
            className="h-9 w-36"
            aria-label={t("versionLabel")}
            data-testid="plugin-marketplace-version-picker"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <InstallButton
        installed={false}
        installing={installing}
        onInstall={() => onInstall(entry.id, selected)}
        installLabel={t("install")}
        installingLabel={t("installing")}
        variant="default"
      />
    </>
  )
}

/**
 * Fetches the entry's full registry manifest and exposes it behind a
 * "View raw manifest" dialog with Shiki JSON highlighting — the same viewer
 * the installed-plugin detail overview uses — so a manifest can be inspected
 * before installing. Renders nothing until a manifest is available (e.g. the
 * registry is unreachable, or a built-in has no remote entry).
 */
function RawManifestSection({ entry }: { entry: DetailEntry }) {
  const t = useTranslations("plugins.marketplaceDetail")
  const [manifest, setManifest] = useState<PluginManifest | null>(entry.manifest ?? null)
  const [open, setOpen] = useState(false)

  // Reset to the new entry's own manifest on switch (React-19 render-time
  // pattern, mirroring InstallSection) before the async fetch resolves.
  const [trackedId, setTrackedId] = useState(entry.id)
  if (trackedId !== entry.id) {
    setTrackedId(entry.id)
    setManifest(entry.manifest ?? null)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const client: MarketplaceClient = await loadPluginMarketplaceClient()
        const full = await client.getPlugin(entry.id)
        if (!cancelled && full?.manifest && Object.keys(full.manifest).length > 0) {
          setManifest(full.manifest)
        }
      } catch {
        // best-effort — registry may be unreachable; keep the seeded manifest
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entry.id])

  if (!manifest || Object.keys(manifest).length === 0) return null

  return (
    <div className="flex justify-end">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            <CodeIcon className="mr-1.5 size-3.5" />
            {t("rawManifest")}
          </Button>
        </DialogTrigger>
        <DialogContent className="w-[95vw] max-w-3xl max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 py-4 border-b">
            <DialogTitle>{t("rawManifestTitle")}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4">
              <CodeBlock
                code={JSON.stringify(manifest, null, 2)}
                language="json"
                filename={`${entry.id}.json`}
                className="my-0"
              />
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MetaCard({ entry }: { entry: DetailEntry }) {
  const t = useTranslations("plugins.marketplaceDetail")
  return (
    <Card className="p-3 space-y-1.5">
      {entry.author && <Row label={t("author")} value={entry.author} />}
      {entry.license && <Row label={t("license")} value={entry.license} />}
      {(entry.capabilities ?? []).length > 0 && (
        <div className="flex items-start justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{t("capabilities")}</span>
          <div className="flex flex-wrap gap-1 justify-end">
            {(entry.capabilities ?? []).map((cap) => (
              <Badge key={cap} variant="outline" className="text-xs">
                {cap}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {entry.homepage && (
        <Row
          label={t("homepage")}
          value={
            <a
              className="inline-flex items-center gap-1 underline"
              href={entry.homepage}
              target="_blank"
              rel="noreferrer"
            >
              {entry.homepage}
              <ExternalLinkIcon className="size-3" />
            </a>
          }
        />
      )}
      {entry.repository && (
        <Row
          label={t("repository")}
          value={
            <a
              className="inline-flex items-center gap-1 underline"
              href={entry.repository}
              target="_blank"
              rel="noreferrer"
            >
              {entry.repository}
              <ExternalLinkIcon className="size-3" />
            </a>
          }
        />
      )}
    </Card>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right break-all">{value}</span>
    </div>
  )
}

function PermissionList({
  title,
  permissions,
}: {
  title: string
  permissions: PluginPermission[]
}) {
  return (
    <Card className="p-3 space-y-1.5">
      <h3 className="text-xs font-semibold">{title}</h3>
      <ul className="space-y-1">
        {permissions.map((perm) => {
          const dangerous = DANGEROUS_PERMISSIONS.includes(perm)
          return (
            <li key={perm} className="flex items-start gap-2 text-xs">
              {dangerous && (
                <AlertTriangleIcon className="size-3 text-destructive shrink-0 mt-0.5" />
              )}
              <code className="font-mono shrink-0">{perm}</code>
              <span className="text-muted-foreground">{PERMISSION_DESCRIPTIONS[perm] ?? perm}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
