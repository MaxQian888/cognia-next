"use client"

// Sheet shown when the user clicks a marketplace card. Surfaces README
// (if the registry returned it), the full permission request preview
// (highlighting dangerous permissions), the dependency list, and a single
// install / uninstall CTA.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
} from "@/lib/plugin/security/permission-guard"
import type { PluginPermission } from "@/types/plugin"
import { PluginSignatureBadge, type SignatureState } from "./plugin-signature-badge"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"

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
      <SheetContent className="w-full sm:max-w-2xl lg:max-w-3xl overflow-y-auto">
        {entry ? (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <SheetTitle className="flex-1 min-w-0">
                  {entry.name}{" "}
                  <span className="text-muted-foreground text-sm font-normal">
                    v{entry.version}
                  </span>
                </SheetTitle>
                <PluginSignatureBadge
                  state={entry.signatureState ?? (entry.signed ? "verified" : "unverified")}
                  signer={entry.author}
                />
              </div>
              {entry.description && <SheetDescription>{entry.description}</SheetDescription>}
            </SheetHeader>

            <div className="space-y-4 mt-4">
              <MetaCard entry={entry} />

              {entry.permissions && entry.permissions.length > 0 && (
                <PermissionList title={t("declared")} permissions={entry.permissions} />
              )}
              {entry.optionalPermissions && entry.optionalPermissions.length > 0 && (
                <PermissionList title={t("optional")} permissions={entry.optionalPermissions} />
              )}

              {entry.dependencies && Object.keys(entry.dependencies).length > 0 && (
                <Card className="p-3 space-y-2">
                  <h3 className="text-xs font-semibold">{t("dependencies")}</h3>
                  <div className="space-y-0.5">
                    {Object.entries(entry.dependencies).map(([dep, version]) => (
                      <div key={dep} className="text-xs flex items-center justify-between">
                        <code className="font-mono">{dep}</code>
                        <span className="text-muted-foreground">{version}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {entry.readme && (
                <Card className="p-0">
                  <ScrollArea className="max-h-[40vh]">
                    <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap font-sans">
                      {entry.readme}
                    </pre>
                  </ScrollArea>
                </Card>
              )}
            </div>

            <SheetFooter className="mt-4">
              {installed ? (
                <Button variant="ghost" onClick={() => onUninstall(entry.id)} disabled={installing}>
                  {installing ? t("uninstalling") : t("uninstall")}
                </Button>
              ) : (
                <Button onClick={() => onInstall(entry.id, entry.version)} disabled={installing}>
                  {installing ? t("installing") : t("install")}
                </Button>
              )}
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
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
