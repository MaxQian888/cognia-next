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
//
// Flat inside the Data tab: a verdict line, a divided list, and conflicts /
// warnings as left-ruled callouts. The canvas sits behind a disclosure because
// it is the costly part; the verdict and list need only the resolver result.

import { useEffect, useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, GitBranchIcon } from "lucide-react"
import { Background, BackgroundVariant, ReactFlow, type Edge, type Node } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Button } from "@/components/ui/button"
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

/** Dependency rows shown before "Show all"; the pane, not this list, scrolls. */
export const DEPENDENCY_ROW_LIMIT = 8

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
  const [graphOpen, setGraphOpen] = useState(false)
  const [showAllRows, setShowAllRows] = useState(false)
  const canvasId = useId()

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

  const dependencyCount = result ? result.resolved.length + result.missing.length : 0
  const resolvedRows = result?.resolved ?? []
  const missingRows = result?.missing ?? []
  const rowCount = resolvedRows.length + missingRows.length
  // Missing dependencies are the actionable rows, so the cap keeps them first.
  const visibleMissing = showAllRows ? missingRows : missingRows.slice(0, DEPENDENCY_ROW_LIMIT)
  const visibleResolved = showAllRows
    ? resolvedRows
    : resolvedRows.slice(0, Math.max(0, DEPENDENCY_ROW_LIMIT - visibleMissing.length))
  const hasGraph = Boolean(model && flow && model.nodes.length > 1)

  return (
    <div className="@container space-y-2" data-testid="plugin-dependency-graph">
      {loading && <p className="text-xs text-muted-foreground">{t("loading")}</p>}

      {error && (
        <p
          className="border-l-2 border-destructive pl-2 text-xs text-destructive break-words"
          role="alert"
        >
          {error}
        </p>
      )}

      {!loading && result && (
        <>
          {/* The verdict, readable without opening the canvas. */}
          {dependencyCount === 0 && result.conflicts.length === 0 ? (
            <p
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="plugin-dependency-none"
            >
              <GitBranchIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {t("noDependencies")}
            </p>
          ) : (
            <p
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
              data-testid="plugin-dependency-summary"
            >
              {result.success ? (
                <span className="text-muted-foreground">{t("allResolved")}</span>
              ) : (
                <span className="font-medium text-destructive">{t("unresolved")}</span>
              )}
              {result.missing.length > 0 && (
                <span className="text-destructive">
                  {t("missingCount", { count: result.missing.length })}
                </span>
              )}
              {result.conflicts.length > 0 && (
                <span className="text-destructive">
                  {t("conflictsTitle", { count: result.conflicts.length })}
                </span>
              )}
              {result.warnings.length > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {t("warningsTitle", { count: result.warnings.length })}
                </span>
              )}
            </p>
          )}

          {/* The resolver's own per-dependency verdict (installed vs
              marketplace vs missing), which a node label has no room for. */}
          {rowCount > 0 && (
            <ul className="divide-y text-xs" aria-label={t("title")}>
              {visibleMissing.map((dep) => (
                <li key={dep} className="flex flex-wrap items-center gap-x-2 py-1 text-destructive">
                  <code className="font-mono break-all">{dep}</code>
                  <span className="ml-auto">{t("missing")}</span>
                </li>
              ))}
              {visibleResolved.map((dep) => (
                <li key={dep.id} className="flex flex-wrap items-center gap-x-2 py-1">
                  <code className="font-mono break-all">{dep.id}</code>
                  <span className="text-muted-foreground">
                    {t("atVersion", { version: dep.version })}
                  </span>
                  <span
                    className={cn(
                      "ml-auto",
                      dep.satisfies ? "text-muted-foreground" : "text-destructive"
                    )}
                  >
                    {t(`source.${dep.source}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {rowCount > DEPENDENCY_ROW_LIMIT && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 text-xs text-muted-foreground pointer-coarse:h-10"
              onClick={() => setShowAllRows((v) => !v)}
              aria-expanded={showAllRows}
            >
              {showAllRows ? t("showLess") : t("showAll", { count: rowCount })}
            </Button>
          )}

          {result.conflicts.length > 0 && (
            <div className="space-y-0.5 border-l-2 border-destructive pl-2" role="group">
              <p className="text-xs font-medium text-destructive">
                {t("conflictsTitle", { count: result.conflicts.length })}
              </p>
              <ul className="space-y-0.5 text-xs text-destructive">
                {result.conflicts.map((c) => (
                  <li key={c.dependencyId} className="font-mono break-words">
                    {t("conflictLine", { dependencyId: c.dependencyId, reason: c.reason })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="space-y-0.5 border-l-2 border-amber-500 pl-2" role="group">
              <p className="text-xs font-medium">
                {t("warningsTitle", { count: result.warnings.length })}
              </p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {result.warnings.map((w, idx) => (
                  <li key={idx} className="break-words">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The canvas is the expensive part (a React Flow instance), so it
              mounts only on request; everything above reads without it. */}
          {hasGraph && model && flow && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-7 text-xs pointer-coarse:h-10"
                onClick={() => setGraphOpen((v) => !v)}
                aria-expanded={graphOpen}
                aria-controls={canvasId}
                data-testid="plugin-dependency-graph-toggle"
              >
                <ChevronRightIcon
                  className={cn("size-3.5 transition-transform", graphOpen && "rotate-90")}
                  aria-hidden="true"
                />
                {graphOpen ? t("hideGraph") : t("showGraph")}
              </Button>
              {graphOpen && (
                <div
                  id={canvasId}
                  className="overflow-hidden rounded-md bg-muted/30"
                  style={{ height: Math.min(model.height, 420) }}
                  role="img"
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
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
