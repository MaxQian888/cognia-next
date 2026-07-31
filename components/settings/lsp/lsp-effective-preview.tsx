"use client"

/**
 * Read-only preview of the EFFECTIVE LSP server list — what the resolver
 * (`lib/lsp/resolve-config.ts`) produces after layering builtin defaults ←
 * user settings ← the active project's `.cognia/lsp.json`. Lets the user see
 * the merge result (and override provenance) of what they edit above.
 *
 * Re-resolves whenever the user layer or the active project changes. The
 * project layer reads through the Tauri fs (`readProjectLspFile`), which
 * returns `null` on web/mobile — the preview then simply shows builtin+user.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import type { LspServerConfig, ResolvedLspServer } from "@/types/lsp/config"
import { resolveLspServers } from "@/lib/lsp/resolve-config"
import { readProjectLspFile } from "@/lib/lsp/project-file-reader"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { Badge } from "@/components/ui/badge"

export interface LspEffectivePreviewProps {
  /** The user layer (`AppSettings.lsp.servers`) currently being edited. */
  userServers: LspServerConfig[]
}

export function LspEffectivePreview({ userServers }: LspEffectivePreviewProps) {
  const t = useTranslations("settings.lspServers")
  const rootDir = useProjectStore((s) => {
    const proj = s.projects.find((p) => p.id === s.activeProjectId)
    return proj ? (primaryRootOf(proj)?.path ?? null) : null
  })

  const [resolved, setResolved] = useState<ResolvedLspServer[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void resolveLspServers({
      rootDir,
      userServers,
      readProjectFile: readProjectLspFile,
    })
      .then((servers) => {
        if (!cancelled) setResolved(servers)
      })
      .catch(() => {
        if (!cancelled) setResolved([])
      })
    return () => {
      cancelled = true
    }
  }, [userServers, rootDir])

  if (resolved === null) return null

  return (
    <div className="space-y-2" data-testid="lsp-effective-preview">
      <h3 className="text-sm font-medium">{t("effectivePreview.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("effectivePreview.description")}</p>
      {resolved.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/30 p-4 text-center text-sm text-muted-foreground">
          {t("effectivePreview.empty")}
        </div>
      ) : (
        <ul className="divide-y rounded-md border">
          {resolved.map((server) => (
            <li
              key={server.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
              data-testid={`lsp-effective-${server.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{server.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {t(`effectivePreview.source.${server.source}`)}
                  </Badge>
                  {server.overriddenBy ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {server.overriddenBy === "builtin"
                        ? t("effectivePreview.overridesBuiltin")
                        : t("effectivePreview.overridden")}
                    </Badge>
                  ) : null}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {server.command}
                  {server.args && server.args.length > 0 ? ` ${server.args.join(" ")}` : ""}
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {server.languages.join(", ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
