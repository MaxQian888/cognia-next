"use client"

/**
 * Repos sub-tab. Lists configured repositories from the github-delivery
 * plugin's namespaced `github-delivery:repos` Dexie table. Per repo:
 *   - Status badges (credential mode, trigger mode, worktree backend).
 *   - "Public webhook URL" section with a "Start cloudflared tunnel" toggle.
 *
 * The cloudflared spawn is desktop-only; web mode disables the toggle with
 * an inline note.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  CopyIcon,
  GitBranchIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  WebhookIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { getDb } from "@/lib/db/schema"
import { isTauri } from "@/lib/tauri"
import { startTunnel, type CloudflaredHandle } from "@/lib/github/cloudflared"
import { createTauriCloudflaredSpawn } from "@/lib/github/cloudflared-tauri"
import type { GhRepoEntry } from "@/lib/github/types"
import type Dexie from "dexie"

const NAMESPACED_TABLE = "github-delivery:repos"
const DEFAULT_WEBHOOK_PORT = 17243

/**
 * Inbound GitHub webhooks are DORMANT — labelled here per Working Rule 7; the
 * other two axes are `connectors[].transportModes: []` in the plugin manifest
 * and the dormancy guard in `plugins/github-delivery/src/connector/inbox-bridge.test.ts`.
 *
 * There is no GitHub webhook receiver: nothing in `src-tauri/` or `crates/`
 * binds {@link DEFAULT_WEBHOOK_PORT}, and `lib/github/event-normalizer.ts`,
 * `lib/github/webhook-verify.ts` and the plugin's `ghEventToInbound` have zero
 * production callers. Offering a "Start cloudflared tunnel" button plus a
 * public URL invited users to point GitHub at an endpoint whose deliveries can
 * only fail, with nothing surfacing the failure. Repos are tracked by polling.
 *
 * The renderer half is complete and tested — flip this to `true` and the
 * control below works again once the receiver lands.
 */
const INBOUND_WEBHOOKS_AVAILABLE = false

function getReposTable(): Dexie.Table<GhRepoEntry, string> | null {
  try {
    const db = getDb() as unknown as Dexie
    return db.table<GhRepoEntry, string>(NAMESPACED_TABLE)
  } catch {
    return null
  }
}

type TunnelState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running"; url: string; handle: CloudflaredHandle }
  | { state: "error"; message: string }

function TunnelControl({ port }: { port: number }) {
  const t = useTranslations("settings.githubDelivery.repos.tunnel")
  const [tunnel, setTunnel] = useState<TunnelState>({ state: "idle" })
  const [copied, setCopied] = useState(false)
  const desktop = isTauri()

  const start = async () => {
    setTunnel({ state: "starting" })
    try {
      const handle = await startTunnel({
        localPort: port,
        spawn: createTauriCloudflaredSpawn(),
      })
      setTunnel({ state: "running", url: handle.publicUrl, handle })
    } catch (err) {
      setTunnel({ state: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  const stop = async () => {
    if (tunnel.state !== "running") return
    await tunnel.handle.stop()
    setTunnel({ state: "idle" })
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  if (!desktop) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="tunnel-web-only">
        {t("webOnly")}
      </p>
    )
  }

  if (!INBOUND_WEBHOOKS_AVAILABLE) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="tunnel-unavailable">
        {t("unavailable")}
      </p>
    )
  }

  return (
    <div className="space-y-1.5" data-testid="tunnel-control">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("localLabel")}</span>
        {/* i18n-exempt: literal webhook URL template, not UI prose */}
        <code className="font-mono">http://127.0.0.1:{port}/webhook/&lt;path&gt;</code>
      </div>
      {tunnel.state === "running" && (
        <div className="flex items-center gap-2 text-xs" data-testid="tunnel-url">
          <CheckCircle2Icon className="h-3 w-3 text-emerald-500" />
          <span className="text-muted-foreground">{t("publicLabel")}</span>
          <code className="font-mono truncate">{tunnel.url}</code>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => copy(tunnel.url)}
            aria-label={t("copyAria")}
            data-testid="tunnel-copy"
          >
            <CopyIcon className="h-3 w-3" />
          </Button>
          {copied && <span className="text-xs text-emerald-600">{t("copied")}</span>}
        </div>
      )}
      {tunnel.state === "error" && (
        <p className="text-xs text-destructive" data-testid="tunnel-error">
          {tunnel.message}
        </p>
      )}
      <div className="flex gap-2">
        {tunnel.state === "running" ? (
          <Button size="sm" variant="outline" onClick={stop} data-testid="tunnel-stop">
            <PowerOffIcon className="h-3 w-3 mr-1" />
            {t("stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={start}
            disabled={tunnel.state === "starting"}
            data-testid="tunnel-start"
          >
            {tunnel.state === "starting" ? (
              <>
                <RefreshCwIcon className="h-3 w-3 mr-1 animate-spin" />
                {t("starting")}
              </>
            ) : (
              <>
                <PowerIcon className="h-3 w-3 mr-1" />
                {t("start")}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

export function ReposTab() {
  const t = useTranslations("settings.githubDelivery.repos")
  const repos = useLiveQuery(async () => {
    const table = getReposTable()
    if (!table) return null
    try {
      return await table.toArray()
    } catch {
      return null
    }
  })

  if (repos === null) {
    return (
      <Card className="p-4 space-y-2" data-testid="repos-empty">
        <div className="flex items-center gap-2 text-muted-foreground">
          <GitBranchIcon className="h-4 w-4" />
          <span className="text-sm">{t("disabledTitle")}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t("disabledHint")}</p>
      </Card>
    )
  }

  if (repos === undefined) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      </Card>
    )
  }

  if (repos.length === 0) {
    return (
      <Card className="p-4 space-y-2" data-testid="repos-none">
        <p className="text-sm">{t("noneTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("noneHint")}</p>
        <Button size="sm" data-testid="add-repo-cta">
          {t("addCta")}
        </Button>
      </Card>
    )
  }

  return (
    <div className="space-y-3" data-testid="repos-list">
      {repos.map((repo) => (
        <Card key={repo.fullName} className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <GitBranchIcon className="h-4 w-4" />
                <p className="font-mono text-sm">{repo.fullName}</p>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <Badge variant="secondary">
                  {repo.credentialMode === "app" ? t("badgeApp") : t("badgePat")}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {repo.triggerMode === "webhook" ? (
                    <span className="flex items-center gap-1">
                      <WebhookIcon className="h-3 w-3" /> {t("webhook")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <RefreshCwIcon className="h-3 w-3" /> {t("polling")}
                    </span>
                  )}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {t("worktree", { mode: repo.worktreeMode })}
                </Badge>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {repo.lastDeliveryAt ? new Date(repo.lastDeliveryAt).toLocaleString() : t("noEvents")}
            </div>
          </div>
          {repo.triggerMode === "webhook" && <TunnelControl port={DEFAULT_WEBHOOK_PORT} />}
        </Card>
      ))}
    </div>
  )
}
