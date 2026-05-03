"use client"

// Visualizes the dependency-resolver output for a single plugin. Surfaces
// the four real channels exposed by `lib/plugin/package/dependency-resolver`:
// resolved entries, missing ids, conflicts, and warnings. The resolver is
// driven by the live installed-plugins list so the picture stays accurate
// across installs and uninstalls.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { listPlugins } from "@/lib/db/plugins"
import {
  getDependencyResolver,
  type ResolutionResult,
} from "@/lib/plugin/package/dependency-resolver"
import type { PluginManifest } from "@/types/plugin"

interface ResolverClient {
  setInstalledPlugins: (plugins: PluginManifest[]) => void
  resolve: (pluginId: string, targetVersion?: string) => Promise<ResolutionResult>
}

let cachedClient: ResolverClient | null = null

function getClient(): ResolverClient {
  if (cachedClient) return cachedClient
  cachedClient = getDependencyResolver()
  return cachedClient
}

export function __resetPluginDependencyResolverForTests(client: ResolverClient | null) {
  cachedClient = client
}

interface Props {
  manifest: {
    id: string
    dependencies?: Record<string, string>
  }
}

export function PluginDependencyGraph({ manifest }: Props) {
  const t = useTranslations("plugins.dependencyGraph")
  const [result, setResult] = useState<ResolutionResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)

    setError(null)
    let cancelled = false
    void (async () => {
      try {
        const installed = await listPlugins()
        const client = getClient()
        client.setInstalledPlugins(
          installed.map((row) => row.manifest as unknown as PluginManifest)
        )
        const r = await client.resolve(manifest.id)
        if (!cancelled) {
          setResult(r)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [manifest.id])

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-2">
        <GitBranchIcon className="size-4" />
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        {result && !result.success && (
          <Badge variant="destructive" className="text-xs ml-auto">
            {t("unresolved")}
          </Badge>
        )}
      </div>

      {loading && <p className="text-xs text-muted-foreground">{t("loading")}</p>}

      {error && <p className="text-xs text-destructive break-words">{error}</p>}

      {!loading && result && (
        <>
          <ScrollArea className="max-h-[40vh]">
            <ul className="space-y-0.5 text-xs">
              <li>
                <code className="font-mono">{manifest.id}</code>
                <span className="text-muted-foreground"> ({t("root")})</span>
              </li>
              {result.resolved.map((dep) => (
                <li key={dep.id} className="pl-4 flex items-center gap-1.5">
                  <span aria-hidden>└─</span>
                  <code className="font-mono">{dep.id}</code>
                  <span className="text-muted-foreground">@ {dep.version}</span>
                  <Badge variant={dep.satisfies ? "outline" : "destructive"} className="text-xs">
                    {dep.source}
                  </Badge>
                </li>
              ))}
              {result.missing.map((dep) => (
                <li key={dep} className="pl-4 text-destructive">
                  └─ <code className="font-mono">{dep}</code>
                  <span> ({t("missing")})</span>
                </li>
              ))}
            </ul>
          </ScrollArea>

          {result.conflicts.length > 0 && (
            <Card className="p-2 border-destructive/40 space-y-1">
              <div className="text-xs font-medium text-destructive">
                {t("conflictsTitle", { count: result.conflicts.length })}
              </div>
              <ul className="space-y-0.5 text-xs text-destructive">
                {result.conflicts.map((c) => (
                  <li key={c.dependencyId} className="font-mono">
                    {c.dependencyId} — {c.reason}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {result.warnings.length > 0 && (
            <Card className="p-2 border-amber-500/40 space-y-1">
              <div className="text-xs font-medium">
                {t("warningsTitle", { count: result.warnings.length })}
              </div>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {result.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </Card>
  )
}
