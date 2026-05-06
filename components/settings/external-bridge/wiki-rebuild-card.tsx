"use client"

import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { BookOpenIcon, Loader2Icon, RotateCwIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getWikiManifest } from "@/lib/db/wiki-manifest"
import { isTauri } from "@/lib/tauri"
import {
  runWikiRebuild,
  WebModeError,
  NoApiKeyError,
  type RunRebuildOptions,
} from "@/lib/wiki/rebuild-runner"
import type { RebuildResult } from "@/lib/wiki/orchestrator"
import type { WikiManifest } from "@/types/wiki"

function formatTime(ts: number | undefined): string {
  if (!ts) return "Never"
  return new Date(ts).toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function WikiRebuildCard() {
  const [busy, setBusy] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [force, setForce] = useState(false)
  const [lastResult, setLastResult] = useState<RebuildResult | null>(null)

  const manifest = useLiveQuery<WikiManifest | undefined>(
    async () => getWikiManifest("cognia-self"),
    []
  )

  const onRebuild = useCallback(async () => {
    setShowConfirm(false)
    setBusy(true)
    setLastResult(null)
    try {
      const opts: RunRebuildOptions = { force }
      const result = await runWikiRebuild(opts)
      setLastResult(result)
      const parts: string[] = []
      if (result.added > 0) parts.push(`${result.added} added`)
      if (result.changed > 0) parts.push(`${result.changed} changed`)
      if (result.removed > 0) parts.push(`${result.removed} removed`)
      if (result.errors.length > 0) parts.push(`${result.errors.length} failed`)
      const summary = parts.length > 0 ? parts.join(", ") : "no changes"
      toast.success(`Wiki rebuilt: ${summary} (${formatDuration(result.durationMs)})`)
    } catch (err) {
      if (err instanceof WebModeError) {
        toast.error("Wiki rebuild requires the desktop app (Tauri).")
      } else if (err instanceof NoApiKeyError) {
        toast.error("No LLM API key configured. Add one in Settings → Providers.")
      } else {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Rebuild failed: ${message}`)
      }
    } finally {
      setBusy(false)
    }
  }, [force])

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
            <span className="flex items-center gap-2">
              <BookOpenIcon className="h-4 w-4" />
              Wiki Index
              {busy && <Loader2Icon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowConfirm(true)}
              disabled={busy || !isTauri()}
            >
              <RotateCwIcon className="h-3.5 w-3.5 mr-1" />
              Rebuild
            </Button>
          </CardTitle>
          <CardDescription className="text-xs">
            {isTauri()
              ? "Index the Cognia codebase so external agents can query it via MCP."
              : "Wiki rebuild requires the Tauri desktop app."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {/* Status rows */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div>
              <Label className="text-xs text-muted-foreground">Scope</Label>
              <p className="font-mono text-xs">cognia-self</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Last build</Label>
              <p className="text-xs">{formatTime(manifest?.lastBuildAt)}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Articles</Label>
              <p className="text-xs">{manifest?.articleCount ?? 0}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Generator</Label>
              <p className="font-mono text-xs">{manifest?.generatorVersion ?? "—"}</p>
            </div>
          </div>

          {/* Force rebuild toggle */}
          <div className="flex items-center justify-between rounded border bg-card px-3 py-2">
            <div>
              <Label className="text-xs">Full rebuild</Label>
              <p className="text-xs text-muted-foreground">
                Ignore cached hashes — re-process every file.
              </p>
            </div>
            <Switch
              checked={force}
              onCheckedChange={setForce}
              disabled={busy}
              aria-label="Full rebuild toggle"
            />
          </div>

          {/* Last rebuild result */}
          {lastResult && (
            <div className="rounded border bg-card px-3 py-2 text-xs">
              <p className="font-medium mb-1">
                Last result ({formatDuration(lastResult.durationMs)})
              </p>
              <div className="grid grid-cols-5 gap-2 text-center">
                <div>
                  <p className="font-mono text-emerald-500">{lastResult.added}</p>
                  <p className="text-muted-foreground">added</p>
                </div>
                <div>
                  <p className="font-mono text-amber-500">{lastResult.changed}</p>
                  <p className="text-muted-foreground">changed</p>
                </div>
                <div>
                  <p className="font-mono text-red-500">{lastResult.removed}</p>
                  <p className="text-muted-foreground">removed</p>
                </div>
                <div>
                  <p className="font-mono text-muted-foreground">{lastResult.unchanged}</p>
                  <p className="text-muted-foreground">unchanged</p>
                </div>
                <div>
                  <p className="font-mono text-red-500">{lastResult.errors.length}</p>
                  <p className="text-muted-foreground">errors</p>
                </div>
              </div>
              {lastResult.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground">
                    {lastResult.errors.length} error(s)
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {lastResult.errors.map((e, i) => (
                      <li key={i} className="flex items-start gap-1 text-red-500">
                        <TriangleAlertIcon className="h-3 w-3 mt-0.5 shrink-0" />
                        <span className="font-mono">
                          {e.module}: {e.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rebuild Wiki?</DialogTitle>
            <DialogDescription>
              {force
                ? "This will re-index the entire codebase from scratch. All existing articles will be replaced."
                : "This will index changed files since the last build. Only modified modules will be re-processed."}{" "}
              This may take several minutes and consume LLM API quota.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={onRebuild}>Rebuild</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
