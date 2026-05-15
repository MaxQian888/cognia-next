"use client"

/**
 * Settings → Automation → Inspector tab.
 *
 * Two-pane debug surface for workflow / character authors:
 *
 * - **Left**: a tree manager. Pick a root (focused window / desktop /
 *   manually captured ref), set max-depth, hit Refresh to call
 *   `desktop.readTree`. Each row exposes a popover with the element's
 *   `locator` JSON + its raw `elementRef` so the author can paste them
 *   into a workflow node.
 * - **Right**: details for the currently-selected element — process,
 *   bounding rect, control type, automation id, class name. Three
 *   "Test pattern" buttons run InvokePattern / TogglePattern /
 *   SelectionItemPattern against the selected ref so the author can
 *   confirm UIA pattern support without leaving the panel.
 *
 * Point-and-click element picking (`desktop_pick_start` / `_cancel`)
 * isn't wired yet — the underlying Rust overlay window lands in M5b
 * alongside the macOS/Linux minimum-viable backends. The button is
 * rendered as disabled with an explainer tooltip for now.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { CrosshairIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { isTauri } from "@/lib/tauri"
import { desktop } from "@/lib/automation/client"
import {
  elementRef as makeElementRef,
  elementRefValue,
  type Capabilities,
  type ElementInfo,
  type ElementRef,
  type PatternKind,
} from "@/lib/automation/types"

interface TreeRow {
  info: ElementInfo
  depth: number
}

export function InspectorTab() {
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [rootMode, setRootMode] = useState<"focused" | "desktop" | "manual">("focused")
  const [manualRef, setManualRef] = useState("")
  const [maxDepth, setMaxDepth] = useState(2)
  const [rows, setRows] = useState<TreeRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<ElementInfo | null>(null)
  const [patternBusy, setPatternBusy] = useState<PatternKind | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    desktop
      .capabilities()
      .then(setCaps)
      .catch((err) => toast.error("Capabilities probe failed", { description: String(err) }))
  }, [])

  const resolveRoot = useCallback(async (): Promise<ElementRef | null> => {
    if (rootMode === "focused") {
      const info = await desktop.getFocus()
      return info.elementRef
    }
    if (rootMode === "manual") {
      const ref = manualRef.trim()
      if (!ref) throw new Error("Provide an elementRef")
      return makeElementRef(ref)
    }
    return null // desktop root
  }, [rootMode, manualRef])

  const refresh = useCallback(async () => {
    setLoading(true)
    setRows(null)
    setSelected(null)
    try {
      const root = await resolveRoot()
      const tree = await desktop.readTree(root, { maxDepth })
      const flat: TreeRow[] = tree.map((info) => ({ info, depth: 0 }))
      setRows(flat)
      if (flat.length > 0) setSelected(flat[0].info)
    } catch (err) {
      toast.error("Tree read failed", { description: String(err) })
    } finally {
      setLoading(false)
    }
  }, [resolveRoot, maxDepth])

  const testPattern = useCallback(
    async (kind: PatternKind) => {
      if (!selected) return
      setPatternBusy(kind)
      try {
        await desktop.invokePattern(selected.elementRef, kind, {})
        toast.success(`${kind} pattern fired`)
      } catch (err) {
        toast.error(`${kind} pattern failed`, { description: String(err) })
      } finally {
        setPatternBusy(null)
      }
    },
    [selected]
  )

  const locatorJson = useMemo(() => {
    if (!selected) return ""
    const loc: Record<string, string | number | undefined> = {}
    if (selected.name) loc.name = selected.name
    if (selected.automationId) loc.automationId = selected.automationId
    if (selected.controlType) loc.controlType = selected.controlType
    if (selected.className) loc.className = selected.className
    if (selected.processName) loc.processName = selected.processName
    if (selected.windowTitle) loc.windowTitleContains = selected.windowTitle
    return JSON.stringify(loc, null, 2)
  }, [selected])

  if (!isTauri()) {
    return (
      <Alert>
        <AlertDescription>
          The inspector requires the Tauri runtime so it can talk to the active accessibility
          backend.
        </AlertDescription>
      </Alert>
    )
  }

  if (!caps) {
    return <Skeleton className="h-72 w-full" />
  }

  if (!caps.hasUia) {
    return (
      <Alert>
        <AlertDescription>
          The active platform back-end ({caps.platform}) doesn&apos;t expose a UIA-equivalent tree.
          The inspector is Windows-only for now; macOS / Linux land in a later milestone.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr,1fr]">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>Tree</CardTitle>
          <CardDescription>
            Read an accessibility tree from the focused window, the desktop root, or a captured ref.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={rootMode === "focused" ? "default" : "outline"}
              onClick={() => setRootMode("focused")}
            >
              Focused
            </Button>
            <Button
              size="sm"
              variant={rootMode === "desktop" ? "default" : "outline"}
              onClick={() => setRootMode("desktop")}
            >
              Desktop
            </Button>
            <Button
              size="sm"
              variant={rootMode === "manual" ? "default" : "outline"}
              onClick={() => setRootMode("manual")}
            >
              Manual
            </Button>
            <Button size="sm" variant="ghost" disabled title="Point-and-click picker lands in M5b">
              <CrosshairIcon className="size-4 mr-1" />
              Pick (M5b)
            </Button>
          </div>
          {rootMode === "manual" && (
            <div className="space-y-1">
              <Label className="text-xs">Element ref</Label>
              <Input
                placeholder="hex string from getFocus / readTree"
                value={manualRef}
                onChange={(e) => setManualRef(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
          )}
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Max depth</Label>
              <Input
                type="number"
                min={0}
                max={6}
                value={maxDepth}
                onChange={(e) => setMaxDepth(Math.max(0, Number(e.target.value) || 0))}
                className="w-24"
              />
            </div>
            <Button onClick={refresh} disabled={loading} size="sm">
              <RefreshCwIcon className="size-4 mr-1" />
              {loading ? "Reading…" : "Read tree"}
            </Button>
          </div>

          <ScrollArea className="h-[360px] rounded-md border">
            {rows ? (
              rows.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">Empty result.</p>
              ) : (
                <div className="divide-y">
                  {rows.map((row, idx) => {
                    const isSel =
                      selected !== null &&
                      elementRefValue(selected.elementRef) === elementRefValue(row.info.elementRef)
                    return (
                      <button
                        key={`${elementRefValue(row.info.elementRef)}-${idx}`}
                        type="button"
                        onClick={() => setSelected(row.info)}
                        className={
                          "block w-full text-left px-3 py-1.5 text-xs hover:bg-muted/40 " +
                          (isSel ? "bg-muted" : "")
                        }
                      >
                        <span className="font-medium">
                          {row.info.name ?? row.info.automationId ?? "(unnamed)"}
                        </span>
                        {row.info.controlType && (
                          <span className="ml-2 text-muted-foreground">
                            [{row.info.controlType}]
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            ) : (
              <p className="p-3 text-xs text-muted-foreground">
                Click &quot;Read tree&quot; to populate.
              </p>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>Element details</CardTitle>
          <CardDescription>
            Inspect the selected element and test which UIA patterns it supports.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!selected ? (
            <p className="text-xs text-muted-foreground">Select a row to inspect.</p>
          ) : (
            <>
              <div className="space-y-1.5 text-xs">
                <Detail label="name" value={selected.name} />
                <Detail label="controlType" value={selected.controlType} />
                <Detail label="automationId" value={selected.automationId} />
                <Detail label="className" value={selected.className} />
                <Detail label="processName" value={selected.processName} />
                <Detail label="windowTitle" value={selected.windowTitle} />
                <Detail
                  label="enabled / focused"
                  value={`${selected.isEnabled} / ${selected.isFocused}`}
                />
                {selected.boundingRect && (
                  <Detail
                    label="bounding rect"
                    value={`(${selected.boundingRect.x}, ${selected.boundingRect.y}) ${selected.boundingRect.width}×${selected.boundingRect.height}`}
                  />
                )}
                <Detail label="elementRef" value={elementRefValue(selected.elementRef)} mono />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Locator JSON</Label>
                <pre className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] font-mono overflow-x-auto">
                  {locatorJson}
                </pre>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard.writeText(locatorJson)
                      toast.success("Copied locator JSON")
                    }}
                  >
                    Copy locator
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard.writeText(elementRefValue(selected.elementRef))
                      toast.success("Copied element ref")
                    }}
                  >
                    Copy ref
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Test patterns</Label>
                <div className="flex flex-wrap gap-2">
                  {(["invoke", "toggle", "selectionItem"] as PatternKind[]).map((k) => (
                    <Button
                      key={k}
                      size="sm"
                      variant="outline"
                      disabled={patternBusy !== null}
                      onClick={() => testPattern(k)}
                    >
                      {patternBusy === k ? "…" : k}
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Driving patterns route through the consent gate just like a regular click.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string
  value: string | null | undefined
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span
        className={(mono ? "font-mono text-[11px] break-all " : "") + "min-w-0 truncate"}
        title={value ?? undefined}
      >
        {value ?? (
          <Badge variant="outline" className="text-[10px]">
            none
          </Badge>
        )}
      </span>
    </div>
  )
}
