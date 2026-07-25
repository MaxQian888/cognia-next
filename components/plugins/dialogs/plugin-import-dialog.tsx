"use client"

// Driven by `usePluginsStore.importStaging`, this dialog shows the manifest
// preview + parse-error list staged by the import flow before the user
// confirms a final install. The actual file pick / archive parse lives in
// the import action button (one level up); this surface is the validation
// gate plus the install dispatch.
//
// The review list also spells out what each manifest declares. Import is the
// one install path that doesn't run the marketplace pre-install chain — it only
// stages a `discovered` row, deliberately, so it stays cheap and reversible —
// which used to mean a hand-written manifest could be accepted with its
// permissions and capabilities never shown. The read-out reuses
// `PermissionListCard` so it reads identically to the pre-install consent step.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, FilePlusIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { upsertPlugin } from "@/lib/db/plugins"
import { usePluginsStore } from "@/stores/plugins"
import type { PluginPermission } from "@/types/plugin"
import { PermissionListCard } from "./plugin-pre-install-dialog"

/** Manifest fields the review read-out surfaces, all optional and untrusted. */
interface ReviewableManifest {
  type?: string
  capabilities?: unknown
  permissions?: unknown
  optionalPermissions?: unknown
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

export function PluginImportDialog() {
  const t = useTranslations("plugins.import")
  const tPre = useTranslations("plugins.preInstall")
  const staging = usePluginsStore((s) => s.importStaging)
  const setStaging = usePluginsStore((s) => s.setImportStaging)
  const [importing, setImporting] = useState(false)

  const open = staging !== null

  const handleConfirm = async () => {
    if (!staging) return
    setImporting(true)
    try {
      // Persist each draft as a discovered row. The plugin manager will pick
      // them up on next discoverPlugins() pass; we deliberately don't try to
      // load them inline so the import path stays cheap and reversible.
      for (const draft of staging.drafts) {
        await upsertPlugin({
          id: draft.id,
          name: draft.name,
          version: draft.version,
          status: "discovered",
          source: "local",
          type: (draft.manifest as { type?: string })?.type === "python" ? "python" : "frontend",
          path: draft.sourceLabel,
          manifest: draft.manifest,
          enabled: false,
          capabilities: Array.isArray((draft.manifest as { capabilities?: string[] })?.capabilities)
            ? (draft.manifest as { capabilities: string[] }).capabilities
            : [],
        })
      }
      setStaging(null)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setStaging(null)}>
      <DialogContent className="w-[95vw] max-w-2xl">
        {staging ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>
                {t("description", { source: staging.sourceLabel })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <Card className="p-0">
                <ScrollArea className="max-h-[40vh]">
                  <ul className="divide-y">
                    {staging.drafts.length === 0 ? (
                      <li className="p-3 text-sm text-muted-foreground">{t("emptyDrafts")}</li>
                    ) : (
                      staging.drafts.map((draft) => {
                        const manifest = (draft.manifest ?? {}) as ReviewableManifest
                        const declared = asStringList(manifest.permissions) as PluginPermission[]
                        const optional = asStringList(
                          manifest.optionalPermissions
                        ) as PluginPermission[]
                        const capabilities = asStringList(manifest.capabilities)
                        return (
                          <li key={draft.id} className="px-3 py-2 space-y-2">
                            <div className="flex items-center gap-2">
                              <FilePlusIcon className="size-4 text-muted-foreground shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{draft.name}</div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {draft.id} · v{draft.version}
                                </div>
                              </div>
                              <Badge variant="outline" className="text-xs">
                                {manifest.type ?? "—"}
                              </Badge>
                            </div>

                            {/* What accepting this manifest actually grants. */}
                            <div
                              className="space-y-1.5 pl-6"
                              data-testid={`import-grants-${draft.id}`}
                            >
                              {declared.length === 0 &&
                              optional.length === 0 &&
                              capabilities.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                  {tPre("permissionsNone")}
                                </p>
                              ) : (
                                <>
                                  {declared.length > 0 && (
                                    <PermissionListCard
                                      title={tPre("permissionsDeclared")}
                                      perms={declared}
                                    />
                                  )}
                                  {optional.length > 0 && (
                                    <PermissionListCard
                                      title={tPre("permissionsOptional")}
                                      perms={optional}
                                    />
                                  )}
                                  {capabilities.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1">
                                      <span className="text-xs text-muted-foreground">
                                        {t("capabilitiesLabel")}
                                      </span>
                                      {capabilities.map((cap) => (
                                        <Badge
                                          key={cap}
                                          variant="secondary"
                                          className="text-[10px]"
                                        >
                                          {cap}
                                        </Badge>
                                      ))}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </li>
                        )
                      })
                    )}
                  </ul>
                </ScrollArea>
              </Card>

              {staging.parseErrors.length > 0 && (
                <Card className="p-3 border-destructive space-y-1.5">
                  <div className="flex items-center gap-1.5 text-destructive">
                    <AlertTriangleIcon className="size-4" />
                    <span className="text-sm font-medium">
                      {t("errorsTitle", { count: staging.parseErrors.length })}
                    </span>
                  </div>
                  <ul className="space-y-0.5 text-xs">
                    {staging.parseErrors.map((err, idx) => (
                      <li key={idx} className="text-muted-foreground">
                        <code className="font-mono">{err.name}</code> — {err.error}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStaging(null)} disabled={importing}>
                {t("cancel")}
              </Button>
              <Button onClick={handleConfirm} disabled={importing || staging.drafts.length === 0}>
                {importing ? t("importing") : t("confirm", { count: staging.drafts.length })}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
