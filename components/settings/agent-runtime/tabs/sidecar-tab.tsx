"use client"

// Sidecar tab — read-only diagnostics for the in-process Claude SDK sidecar.
// Polls `getSidecarStatus()` every 3s when running in Tauri; surfaces the
// most recent SDK session id from the active chat session for traceability.
// Restart button is desktop-only.
//
// Stage 5 enrichments: SDK + sidecar version (from the sidecar's `ready`
// event), live counts of slash commands / hooks / MCP servers / sessions,
// and a deep-link strip to related Settings sections.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useLiveQuery } from "dexie-react-hooks"
import { ExternalLinkIcon } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"
import { getSidecarStatus, restartSidecar } from "@/lib/claude/ipc"
import { useChatStore } from "@/stores/chat"
import { getSession, listSessions } from "@/lib/db/sessions"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { useSidecarInfo } from "@/lib/claude/sidecar-info"
import { BUILTIN_SLASH_COMMANDS } from "@/lib/slash-commands/builtin"
import { listSlashCommands } from "@/lib/slash-commands/registry"
import { CliSyncCard } from "@/components/settings/cli-bridge/cli-sync-card"
import { SdkCapabilitiesCard } from "@/components/settings/agent-runtime/sdk-capabilities-card"

const POLL_INTERVAL_MS = 3000

export function SidecarTab() {
  const t = useTranslations("settings.agentRuntimeSection.sidecar")
  const router = useRouter()
  const desktop = isTauri()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sidecarInfo = useSidecarInfo()

  const sessions = useLiveQuery(() => listSessions(), [])
  const mcpServers = useLiveQuery(() => listMcpServers(), [])

  const slashCommandCount =
    BUILTIN_SLASH_COMMANDS.length + listSlashCommands().filter((c) => c.source !== "builtin").length
  const sessionCount = sessions?.length ?? 0
  const mcpEnabledCount = mcpServers?.filter((s) => s.enabled).length ?? 0
  const mcpTotalCount = mcpServers?.length ?? 0

  const [ready, setReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [sdkSessionId, setSdkSessionId] = useState<string | null>(null)

  // Status & SDK-session-id reads are external IO; the warnings about
  // synchronous setState are acceptable for this read-only diagnostics tab.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!desktop) {
      setReady(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const r = await getSidecarStatus()
        if (!cancelled) setReady(Boolean(r.ready))
      } catch {
        if (!cancelled) setReady(false)
      }
      if (!cancelled) timer = setTimeout(refresh, POLL_INTERVAL_MS)
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [desktop])

  useEffect(() => {
    let cancelled = false
    if (!activeSessionId) {
      setSdkSessionId(null)
      return
    }
    void (async () => {
      try {
        const s = await getSession(activeSessionId)
        if (!cancelled) setSdkSessionId(s?.sdkSessionId ?? null)
      } catch {
        if (!cancelled) setSdkSessionId(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleRestart = async () => {
    setBusy(true)
    try {
      await restartSidecar()
      toast.success(t("restartedToast"))
      // Optimistically reset the badge until the next poll lands.
      setReady(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const goTo = (section: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ section, ...(extra ?? {}) })
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("title")}</CardTitle>
          <CardDescription className="text-xs">{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t("statusLabel")}</dt>
              <dd className="mt-1">
                {!desktop ? (
                  <Badge variant="outline">{t("webOnly")}</Badge>
                ) : ready === true ? (
                  <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                    {t("running")}
                  </Badge>
                ) : ready === false ? (
                  <Badge variant="outline" className="bg-destructive/15 text-destructive">
                    {t("stopped")}
                  </Badge>
                ) : (
                  <Badge variant="outline">{t("checking")}</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("sdkSessionLabel")}</dt>
              <dd className="mt-1 truncate font-mono text-xs">{sdkSessionId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("sdkVersionLabel")}</dt>
              <dd className="mt-1 flex items-center gap-1 font-mono text-xs">
                {sidecarInfo.sdkVersion ? (
                  <a
                    href={`https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/${sidecarInfo.sdkVersion}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
                    data-testid="sidecar-sdk-version"
                  >
                    {sidecarInfo.sdkVersion}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("sidecarVersionLabel")}</dt>
              <dd className="mt-1 font-mono text-xs">
                {sidecarInfo.sidecarVersion ?? <span className="text-muted-foreground">—</span>}
              </dd>
            </div>
          </dl>

          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Button
              onClick={() => void handleRestart()}
              disabled={!desktop || busy}
              aria-disabled={!desktop || busy}
              aria-label={t("restartBtn")}
            >
              {t("restartBtn")}
            </Button>
            {!desktop && (
              <p className="text-xs text-muted-foreground" role="status">
                {t("desktopOnlyHint")}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("countsTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("countsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CountTile
              label={t("countSessions")}
              value={sessionCount}
              onClick={() => goTo("agent-runtime", { agentRuntimeTab: "sessions" })}
              testId="count-tile-sessions"
            />
            <CountTile
              label={t("countSlashCommands")}
              value={slashCommandCount}
              onClick={() => goTo("slash-commands")}
              testId="count-tile-slash-commands"
            />
            <CountTile
              label={t("countHooks")}
              value={null}
              hint={t("countHooksHint")}
              onClick={() => goTo("hooks")}
              testId="count-tile-hooks"
            />
            <CountTile
              label={t("countMcpServers")}
              value={`${mcpEnabledCount}/${mcpTotalCount}`}
              onClick={() => goTo("mcp")}
              testId="count-tile-mcp"
            />
          </div>
        </CardContent>
      </Card>

      <SdkCapabilitiesCard />

      <CliSyncCard />
    </div>
  )
}

interface CountTileProps {
  label: string
  value: number | string | null
  hint?: string
  onClick?: () => void
  testId?: string
}

function CountTile({ label, value, hint, onClick, testId }: CountTileProps) {
  const display = value === null ? (hint ?? "—") : String(value)
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      data-testid={testId}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate font-mono text-sm">{display}</p>
    </button>
  )
}

export default SidecarTab
