"use client"

// Visualizes the dependency-resolver output for a single plugin.
//
// The resolver already computes a real graph — a Kahn topological sort in
// `installOrder`, plus pairwise conflicts that name every plugin demanding a
// dependency and with what constraint. This used to render all of that as four
// flat lists, which threw away the two facts only a graph can show: that B must
// be installed before C, and that a conflict is a *disagreement between two
// dependents* about the same dependency.
//
// Layout lives in `plugin-dependency-graph-model.ts` (pure, so it is asserted
// directly); this file is the canvas and the legend. The graph is
// non-interactive — the arrangement carries the meaning, so letting a user drag
// nodes around would only destroy information.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon } from "lucide-react"
import { Background, BackgroundVariant, ReactFlow, type Edge, type Node } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { listPlugins } from "@/lib/db/plugins"
import {
  getDependencyResolver,
  type ResolutionResult,
} from "@/lib/plugin/package/dependency-resolver"
import { cn } from "@/lib/utils"
import type { PluginManifest } from "@/types/plugin"
import {
  buildDependencyGraph,
  type DependencyGraphModel,
  type DependencyNodeKind,
} from "./plugin-dependency-graph-model"

const PRO_OPTIONS = { hideAttribution: true } as const

/** Border/text treatment per node kind. Colour is the only status channel. */
const NODE_CLASS: Readonly<Record<DependencyNodeKind, string>> = {
  root: "!border-primary !bg-primary/10 !font-medium",
  resolved: "!border-border",
  unsatisfied: "!border-amber-500",
  missing: "!border-destructive !bg-destructive/10",
  conflicted: "!border-destructive",
}

function toFlow(model: DependencyGraphModel): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: model.nodes.map((node) => ({
      id: node.id,
      position: node.position,
      data: { label: node.version ? `${node.label}\n${node.version}` : node.label },
      type: "default",
      draggable: false,
      connectable: false,
      selectable: false,
      className: cn("!text-xs !font-mono !whitespace-pre-line", NODE_CLASS[node.kind]),
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      selectable: false,
      className: edge.conflicted ? "!stroke-destructive" : undefined,
      labelStyle: { fontSize: 10 },
    })),
  }
}

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

  const model = useMemo(
    () => (result ? buildDependencyGraph(manifest.id, result) : null),
    [manifest.id, result]
  )
  const flow = useMemo(() => (model ? toFlow(model) : null), [model])

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
          {model && flow && model.nodes.length > 1 ? (
            <div
              className="overflow-hidden rounded-md border"
              style={{ height: Math.min(model.height, 420) }}
              aria-label={t("graphLabel")}
              data-testid="plugin-dependency-canvas"
            >
              <ReactFlow
                nodes={flow.nodes}
                edges={flow.edges}
                proOptions={PRO_OPTIONS}
                fitView
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnDrag
                zoomOnScroll={false}
                zoomOnDoubleClick={false}
                minZoom={0.4}
                maxZoom={1.2}
              >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              </ReactFlow>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs" data-testid="plugin-dependency-none">
              {t("noDependencies")}
            </p>
          )}

          {/* The graph shows structure; this list keeps the resolver's own
              per-dependency verdict (installed vs marketplace vs missing)
              readable, which a node label has no room for. */}
          <ScrollArea className="max-h-[30vh]">
            <ul className="space-y-0.5 text-xs">
              {result.resolved.map((dep) => (
                <li key={dep.id} className="flex items-center gap-1.5">
                  <code className="font-mono">{dep.id}</code>
                  <span className="text-muted-foreground">@ {dep.version}</span>
                  <Badge variant={dep.satisfies ? "outline" : "destructive"} className="text-xs">
                    {dep.source}
                  </Badge>
                </li>
              ))}
              {result.missing.map((dep) => (
                <li key={dep} className="text-destructive">
                  <code className="font-mono">{dep}</code>
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
