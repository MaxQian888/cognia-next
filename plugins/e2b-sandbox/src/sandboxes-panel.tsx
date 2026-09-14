"use client"

/**
 * Context Workbench panel for the E2B plugin — a read-mostly operator view of
 * the shared sandbox pool: connection state up top, one row per live
 * workspace, and a per-row release that runs the same `removeWorkspace`
 * lifecycle the workspace backend exposes (it never force-kills a workspace a
 * runtime still owns — the row shows the pending "released" state instead).
 *
 * Everything the panel touches comes through `panel-runtime.ts` — the host
 * owns the mount and hands the renderer only `{resource, active}`.
 */

import { useState, useSyncExternalStore } from "react"
import { BoxIcon } from "lucide-react"
import { Badge, Button, cn, ScrollArea } from "@cognia/plugin-ui"
import type { ContextPanelRenderProps } from "@cognia/plugin-sdk"
import type { E2BSandboxPoolEntry } from "./sandbox-pool"
import {
  getE2BPanelRuntimeVersion,
  peekE2BPanelRuntime,
  subscribeE2BPanelRuntime,
  type E2BConnectionStatus,
} from "./panel-runtime"
import { usePluginT, type PluginTranslate } from "./use-plugin-t"

export function SandboxesPanel({ resource }: ContextPanelRenderProps) {
  const t = usePluginT()
  // One external store covers both signals: the runtime swaps on
  // activate/deactivate, and the bridge funnels every pool mutation through
  // the same version bump — the monotonic version is the whole snapshot.
  useSyncExternalStore(subscribeE2BPanelRuntime, getE2BPanelRuntimeVersion, () => 0)
  const runtime = peekE2BPanelRuntime()
  const pool = runtime?.pool

  const entries = pool?.snapshot() ?? []
  const status = runtime?.getConnectionStatus() ?? null
  const sessionId = resource.kind === "session" ? resource.sessionId : null

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <BoxIcon className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-medium">{t("panel.title")}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{t("panel.subtitle")}</p>
      </div>

      {runtime && status ? <StatusHeader status={status} t={t} /> : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {!runtime ? (
            <p className="text-xs text-muted-foreground">{t("panel.unavailable")}</p>
          ) : entries.length === 0 ? (
            <div className="space-y-1.5 py-4 text-center">
              <p className="text-sm font-medium">{t("panel.empty.title")}</p>
              <p className="text-xs text-muted-foreground">{t("panel.empty.body")}</p>
            </div>
          ) : (
            entries.map((entry) => (
              <WorkspaceRow
                key={entry.workspacePath}
                entry={entry}
                currentSessionId={sessionId}
                t={t}
                onRelease={async (path) => {
                  try {
                    await pool?.removeWorkspace(path)
                  } catch {
                    runtime.ui?.showToast(t("panel.row.releaseFailed", { path }), "error")
                  }
                }}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <p className="border-t px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
        {t("panel.hint")}
      </p>
    </div>
  )
}

function StatusHeader({ status, t }: { status: E2BConnectionStatus; t: PluginTranslate }) {
  return (
    <div className="space-y-1.5 border-b px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{t("panel.status.endpoint")}</span>
        <Badge variant="outline" className="max-w-48 truncate font-mono text-[10px]">
          {status.kind === "cloud" ? t("panel.status.cloud") : status.endpoint}
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{t("panel.status.apiKey")}</span>
        <Badge
          variant={status.apiKey === "keyring" ? "secondary" : "outline"}
          className={cn(
            "text-[10px]",
            status.apiKey === "missing" && "border-amber-500/40 text-amber-600 dark:text-amber-400"
          )}
        >
          {status.apiKey === "keyring"
            ? t("panel.status.keyring")
            : status.apiKey === "pending"
              ? t("panel.status.keyPending")
              : t("panel.status.keyMissing")}
        </Badge>
      </div>
      <p className="text-[10px] text-muted-foreground">{t("panel.status.sdkDormant")}</p>
    </div>
  )
}

function WorkspaceRow({
  entry,
  currentSessionId,
  t,
  onRelease,
}: {
  entry: E2BSandboxPoolEntry
  currentSessionId: string | null
  t: PluginTranslate
  onRelease: (workspacePath: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const claimedByCurrentSession = currentSessionId !== null && entry.ownerGroup === currentSessionId
  const busy = entry.closing || releasing

  return (
    <div
      className={cn(
        "space-y-1.5 rounded-md border px-2.5 py-2",
        claimedByCurrentSession && "border-primary/40"
      )}
      data-testid={`sandbox-row-${entry.workspacePath}`}
    >
      <div className="flex items-start justify-between gap-2">
        <code
          className="min-w-0 flex-1 break-all font-mono text-[11px] leading-snug"
          title={entry.workspacePath}
        >
          {entry.workspacePath}
        </code>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {entry.network === "on" ? t("panel.row.networkOn") : t("panel.row.networkOff")}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="font-mono">{entry.sandboxId}</span>
        {entry.ownerGroup ? (
          <span>· {t("panel.row.session", { id: entry.ownerGroup })}</span>
        ) : null}
        <span>· {t("panel.row.owners", { count: entry.ownerRefs.length })}</span>
        {entry.handleReleased ? (
          <Badge variant="outline" className="text-[10px]">
            {t("panel.row.released")}
          </Badge>
        ) : null}
        {entry.closing ? (
          <Badge variant="outline" className="text-[10px]">
            {t("panel.row.closing")}
          </Badge>
        ) : null}
      </div>
      {!entry.handleReleased ? (
        <Button
          type="button"
          variant={confirming ? "destructive" : "ghost"}
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={busy}
          aria-label={t("panel.row.releaseAria", { path: entry.workspacePath })}
          data-testid={`sandbox-release-${entry.workspacePath}`}
          onClick={() => {
            if (!confirming) {
              setConfirming(true)
              return
            }
            setConfirming(false)
            setReleasing(true)
            void onRelease(entry.workspacePath).finally(() => setReleasing(false))
          }}
        >
          {confirming ? t("panel.row.releaseConfirm") : t("panel.row.release")}
        </Button>
      ) : null}
    </div>
  )
}
