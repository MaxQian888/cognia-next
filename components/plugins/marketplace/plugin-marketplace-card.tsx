"use client"

// Compact card used in the marketplace browse grid. Mirrors the shape of
// `components/skills/skill-marketplace-card.tsx` but adds plugin-specific
// concerns: signature badge, danger-permission warning, capability count.
//
// Three optional props (`verifiedPublisher`, `integrityChecked`,
// `unsupportedApis`) serve the Open VSX section. All three are additive: when
// absent — which is every cognia-registry entry — the render is unchanged.
// That is why this is one card rather than a parallel VS Code card that would
// drift from this one on the first styling change.

import { useTranslations } from "next-intl"
import {
  DownloadIcon,
  StarIcon,
  AlertTriangleIcon,
  GitCompareIcon,
  BadgeCheckIcon,
  FileCheckIcon,
  PlugZapIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginSourceBadge } from "../plugin-source-badge"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"
import { usePluginMarketplaceStore } from "@/stores/plugin-runtime/plugin-marketplace-store"
import { cn } from "@/lib/utils"
import { CapabilityChips } from "../_shared/capability-chips"
import { InstallButton } from "../_shared/install-button"
import { InstalledMarker } from "../_shared/installed-marker"
import { PluginVersionBadge } from "../_shared/plugin-version-badge"

interface Props {
  entry: PluginMarketplaceEntry & {
    /** Optional fields the registry may carry — kept loose because the entry
     * shape is shared between Skills and Plugins marketplaces. */
    capabilities?: string[]
    permissions?: string[]
    signatureState?: SignatureState
  }
  installed: boolean
  installing: boolean
  /**
   * Open VSX's `verified` flag: **its** assertion that the publisher controls
   * the namespace. Rendered with the attribution baked into the label
   * ("Publisher verified by Open VSX") because it is not our claim, and it is
   * not a safety claim — a verified publisher can still ship malware.
   *
   * Never derive this from a signature check; we don't do one. See
   * `use-openvsx-marketplace.ts:toMarketplaceEntry`.
   */
  verifiedPublisher?: boolean
  /**
   * The `.vsix` was verified against Open VSX's SHA-256 digest at install.
   *
   * Only ever true for something already installed — before an install nothing
   * has been checked, and a badge claiming otherwise would be a lie about work
   * we haven't done. The copy stays scoped to what a checksum proves: the
   * transfer wasn't corrupted. It is **not** a signature, and it says nothing
   * about a compromised registry (which serves the file and the digest).
   */
  integrityChecked?: boolean
  /**
   * `vscode.*` namespaces the extension references that cognia's shim doesn't
   * implement, read back from the installed manifest so the warning outlives
   * the install dialog. Best-effort — see `engine-compat.ts`.
   */
  unsupportedApis?: string[]
  onView: (id: string) => void
  onInstall: (id: string, version?: string) => void
  onUninstall: (id: string) => void
}

/** Badge + tooltip. Local because these three claims each need their caveat. */
function ExplainedBadge({
  icon: Icon,
  label,
  tooltip,
  variant,
  testId,
}: {
  icon: typeof BadgeCheckIcon
  label: string
  tooltip: string
  variant: "secondary" | "outline" | "destructive"
  testId: string
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={variant} className="text-xs gap-1" data-testid={testId}>
            <Icon className="size-3" />
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs max-w-64">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function PluginMarketplaceCard({
  entry,
  installed,
  installing,
  verifiedPublisher,
  integrityChecked,
  unsupportedApis,
  onView,
  onInstall,
  onUninstall,
}: Props) {
  const t = useTranslations("plugins.marketplaceCard")
  const tv = useTranslations("plugins.openVsx")
  const comparisonIds = usePluginMarketplaceStore((s) => s.comparisonIds)
  const addToComparison = usePluginMarketplaceStore((s) => s.addToComparison)
  const removeFromComparison = usePluginMarketplaceStore((s) => s.removeFromComparison)
  const inComparison = comparisonIds.includes(entry.id)
  const comparisonFull = !inComparison && comparisonIds.length >= 2
  const dangerous =
    (entry.permissions ?? []).filter(
      (p) =>
        p === "shell:execute" ||
        p === "process:spawn" ||
        p === "python:execute" ||
        p === "filesystem:write"
    ).length > 0
  const sigState = entry.signatureState ?? (entry.signed ? "verified" : "unverified")
  // Built-in plugins ship with the app and can't be installed / uninstalled —
  // they show a read-only Built-in badge in place of the install CTA.
  const isBuiltin = entry.source === "builtin"

  return (
    <Card className="flex flex-col gap-0 py-0">
      <CardHeader className="gap-2 px-3 pt-3">
        <CardTitle className="min-w-0">
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start p-0 text-left font-normal hover:bg-transparent"
            onClick={() => onView(entry.id)}
          >
            <span className="block w-full min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="font-medium truncate">{entry.name}</span>
                <PluginVersionBadge version={entry.version} className="shrink-0" />
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {entry.id}
              </span>
            </span>
          </Button>
        </CardTitle>
        <CardAction>
          <PluginSignatureBadge state={sigState} compact />
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-2 px-3 py-2">
        {entry.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-1">
          <CapabilityChips capabilities={entry.capabilities ?? []} limit={3} />
          {dangerous && (
            <Badge variant="destructive" className="text-xs gap-1">
              <AlertTriangleIcon className="size-3" />
              {t("dangerous")}
            </Badge>
          )}
          {verifiedPublisher && (
            <ExplainedBadge
              icon={BadgeCheckIcon}
              label={tv("publisherVerified")}
              tooltip={tv("publisherVerifiedTooltip", {
                namespace: entry.author ?? entry.id.split(".")[0],
              })}
              variant="secondary"
              testId={`plugin-openvsx-verified-${entry.id}`}
            />
          )}
          {integrityChecked && (
            <ExplainedBadge
              icon={FileCheckIcon}
              label={tv("integrityChecked")}
              tooltip={tv("integrityCheckedTooltip")}
              variant="outline"
              testId={`plugin-openvsx-integrity-${entry.id}`}
            />
          )}
          {unsupportedApis && unsupportedApis.length > 0 && (
            <ExplainedBadge
              icon={PlugZapIcon}
              label={tv("unsupportedApis", { apis: unsupportedApis.join(", ") })}
              tooltip={tv("unsupportedApisTooltip", { apis: unsupportedApis.join(", ") })}
              variant="destructive"
              testId={`plugin-openvsx-unsupported-${entry.id}`}
            />
          )}
        </div>
      </CardContent>

      <CardFooter className="mt-auto justify-between gap-2 px-3 pb-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          {typeof entry.rating === "number" && entry.rating > 0 && (
            <span className="flex items-center gap-0.5">
              <StarIcon className="size-3 fill-current" />
              {entry.rating.toFixed(1)}
            </span>
          )}
          {typeof entry.downloads === "number" && entry.downloads > 0 && (
            <span className="flex items-center gap-0.5">
              <DownloadIcon className="size-3" />
              {entry.downloads.toLocaleString()}
            </span>
          )}
          {entry.author && <span className="truncate">{entry.author}</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isBuiltin ? (
            <PluginSourceBadge source="builtin" />
          ) : installed ? (
            <>
              <InstalledMarker />
              <InstallButton
                installed
                installing={installing}
                onInstall={() => onInstall(entry.id, entry.version)}
                onUninstall={() => onUninstall(entry.id)}
              />
            </>
          ) : (
            <>
              <Button
                size="icon"
                variant="ghost"
                className={cn("size-7", inComparison && "text-primary")}
                onClick={() =>
                  inComparison ? removeFromComparison(entry.id) : addToComparison(entry.id)
                }
                disabled={comparisonFull}
                aria-label={
                  inComparison
                    ? t("removeFromCompareAria", { name: entry.name })
                    : t("addToCompareAria", { name: entry.name })
                }
                aria-pressed={inComparison}
                data-testid={`plugin-marketplace-compare-toggle-${entry.id}`}
              >
                <GitCompareIcon className="size-3.5" />
              </Button>
              <InstallButton
                installed={false}
                installing={installing}
                onInstall={() => onInstall(entry.id, entry.version)}
              />
            </>
          )}
        </div>
      </CardFooter>
    </Card>
  )
}
