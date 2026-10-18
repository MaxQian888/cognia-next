"use client"

// Sidecar tab — read-only diagnostics for the in-process Claude SDK sidecar.
// Polls `getSidecarStatus()` every 3s when running in Tauri; surfaces the
// most recent SDK session id from the active chat session for traceability.
// Restart button is desktop-only.
//
// Stage 5 enrichments: SDK + sidecar version (from the sidecar's `ready`
// event), live counts of slash commands / hooks / MCP servers / active
// conversations,
// and a deep-link strip to related Settings sections.

import { useEffect, useRef, useState } from "react"
import type { AgentLocalExtensionRef } from "@cognia/agent-contracts/session-operations"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useLiveQuery } from "dexie-react-hooks"
import { ExternalLinkIcon } from "lucide-react"

import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"
import { getSidecarStatus, restartSidecar } from "@/lib/claude/ipc"
import { useChatStore } from "@/stores/chat"
import { getSession, listSessions, updateSession } from "@/lib/db/sessions"
import { countExposedConversations } from "@/components/settings/agent-runtime/sdk-bound-conversations"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { useSidecarInfo } from "@/lib/claude/sidecar-info"
import { BUILTIN_SLASH_COMMANDS } from "@/lib/slash-commands/builtin"
import { listSlashCommands } from "@/lib/slash-commands/registry"
import { CliSyncCard } from "@/components/settings/cli-bridge/cli-sync-card"
import { SdkCapabilitiesCard } from "@/components/settings/agent-runtime/sdk-capabilities-card"
import { SdkParityCard } from "@/components/settings/agent-runtime/sdk-parity-card"
import { useAgentExecutionHandle } from "@/components/providers/agent-execution-handle-provider"

const POLL_INTERVAL_MS = 3000

export function SidecarTab() {
  const t = useTranslations("settings.agentRuntimeSection.sidecar")
  const router = useRouter()
  const desktop = isTauri()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const executionHandle = useAgentExecutionHandle(activeSessionId)
  const sidecarInfo = useSidecarInfo()

  const sessions = useLiveQuery(() => listSessions(), [])
  const mcpServers = useLiveQuery(() => listMcpServers(), [])

  const slashCommandCount =
    BUILTIN_SLASH_COMMANDS.length + listSlashCommands().filter((c) => c.source !== "builtin").length
  // Conversations the user can open from the list — not every row in the
  // table, which also holds embedded subagent / workflow-editor sessions and
  // the archive. Matches the "active" figure on the Sessions tab it links to.
  const sessionCount = sessions ? countExposedConversations(sessions).active : 0
  const mcpEnabledCount = mcpServers?.filter((s) => s.enabled).length ?? 0
  const mcpTotalCount = mcpServers?.length ?? 0

  const [ready, setReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [capabilityBusy, setCapabilityBusy] = useState<
    "reloadPlugins" | "reloadSkills" | "reinitialize" | null
  >(null)
  const [extensionPath, setExtensionPath] = useState("")
  const [preservePromptCache, setPreservePromptCache] = useState(true)
  const [extensionResult, setExtensionResult] = useState<
    "applied" | "held" | "partial" | "removed" | null
  >(null)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [savedExtensions, setSavedExtensions] = useState<{
    sessionId: string | null
    refs: AgentLocalExtensionRef[]
  }>({ sessionId: null, refs: [] })
  const extensionRevision = useRef(0)
  const extensionSessionId = useRef(activeSessionId)
  const visibleExtensions =
    savedExtensions.sessionId === activeSessionId ? savedExtensions.refs : []
  const extensionsSupported =
    executionHandle?.spec?.capabilities.effective.includes("extensions.dynamic") === true
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
    const revision = ++extensionRevision.current
    extensionSessionId.current = activeSessionId
    setSavedExtensions({ sessionId: activeSessionId, refs: [] })
    setExtensionResult(null)
    if (!activeSessionId) {
      setSdkSessionId(null)
      return
    }
    void (async () => {
      try {
        const s = await getSession(activeSessionId)
        if (!cancelled) {
          setSdkSessionId(s?.sdkSessionId ?? null)
          if (extensionRevision.current === revision) {
            setSavedExtensions({ sessionId: activeSessionId, refs: s?.runtimeExtensions ?? [] })
          }
        }
      } catch (error) {
        if (!cancelled) {
          setSdkSessionId(null)
          toast.error(error instanceof Error ? error.message : String(error))
        }
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

  const handleCapabilityAction = async (
    action: "reloadPlugins" | "reloadSkills" | "reinitialize"
  ) => {
    if (!executionHandle) return
    setCapabilityBusy(action)
    try {
      await executionHandle[action]()
      toast.success(t("capabilityActionSucceeded"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCapabilityBusy(null)
    }
  }

  const addExtension = async () => {
    if (!executionHandle || !activeSessionId || !extensionPath.trim()) return
    const path = extensionPath.trim()
    const sessionId = activeSessionId
    const revision = extensionRevision.current
    setExtensionBusy(true)
    setExtensionResult(null)
    try {
      let savedRefs: AgentLocalExtensionRef[] | undefined
      const result = await executionHandle.reloadExtensions({
        add: [{ kind: "directory", path }],
        preservePromptCache,
      })
      if (result.disposition !== "held" && result.added.length) {
        const session = await getSession(sessionId)
        if (!session) throw new Error(t("extensionSessionUnavailable"))
        const refs = new Map((session.runtimeExtensions ?? []).map((ref) => [ref.path, ref]))
        for (const ref of result.added) refs.set(ref.path, ref)
        const next = [...refs.values()]
        await updateSession(sessionId, { runtimeExtensions: next })
        savedRefs = next
      }
      if (extensionSessionId.current === sessionId && extensionRevision.current === revision) {
        if (savedRefs) {
          ++extensionRevision.current
          setSavedExtensions({ sessionId, refs: savedRefs })
        }
        setExtensionResult(result.disposition)
        if (result.disposition === "applied") {
          setExtensionPath((current) => (current.trim() === path ? "" : current))
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setExtensionBusy(false)
    }
  }

  const removeSavedExtensions = async (path?: string) => {
    if (!activeSessionId) return
    const sessionId = activeSessionId
    const revision = extensionRevision.current
    setExtensionBusy(true)
    setExtensionResult(null)
    try {
      const session = await getSession(sessionId)
      if (!session) throw new Error(t("extensionSessionUnavailable"))
      const refs =
        path === undefined
          ? []
          : (session.runtimeExtensions ?? []).filter((ref) => ref.path !== path)
      await updateSession(sessionId, { runtimeExtensions: refs })
      if (extensionSessionId.current === sessionId && extensionRevision.current === revision) {
        ++extensionRevision.current
        setSavedExtensions({ sessionId, refs })
        setExtensionResult("removed")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setExtensionBusy(false)
    }
  }

  const goTo = (section: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ section, ...(extra ?? {}) })
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  return (
    <SettingsStack>
      <SettingsBlock title={t("title")} description={t("description")}>
        <dl className="grid grid-cols-1 gap-3 text-sm @md/settings-stack:grid-cols-2">
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

        <div className="flex flex-col gap-2 @md/settings-stack:flex-row @md/settings-stack:items-center">
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
      </SettingsBlock>

      <SettingsBlock title={t("countsTitle")} description={t("countsDescription")}>
        {/* Jump-off counters: one divided strip, so four numbers do not arrive
            as four floating cards inside the runtime pane. */}
        <div
          className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border/60 @md/settings-stack:grid-cols-4"
          data-hairline-grid
        >
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
      </SettingsBlock>

      <SdkCapabilitiesCard />

      <SettingsBlock
        title={t("capabilityControlsTitle")}
        description={t("capabilityControlsDescription")}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void handleCapabilityAction("reloadPlugins")}
            disabled={!desktop || !executionHandle || capabilityBusy !== null}
            aria-label={t("reloadPluginsBtn")}
          >
            {t("reloadPluginsBtn")}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleCapabilityAction("reloadSkills")}
            disabled={!desktop || !executionHandle || capabilityBusy !== null}
            aria-label={t("reloadSkillsBtn")}
          >
            {t("reloadSkillsBtn")}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleCapabilityAction("reinitialize")}
            disabled={!desktop || !executionHandle || capabilityBusy !== null}
            aria-label={t("reinitializeBtn")}
          >
            {t("reinitializeBtn")}
          </Button>
        </div>
        {!executionHandle ? (
          <p className="text-xs text-muted-foreground" role="status">
            {t("liveHandleUnavailable")}
          </p>
        ) : null}
      </SettingsBlock>

      <SettingsBlock title={t("extensionsTitle")} description={t("extensionsDescription")}>
        {visibleExtensions.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("savedExtensions")}</p>
            <ul aria-label={t("savedExtensions")} className="divide-y rounded-lg border">
              {visibleExtensions.map((ref) => (
                <li key={ref.path} className="flex items-center justify-between gap-2 p-3">
                  <span className="min-w-0 break-all font-mono text-xs">{ref.path}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={extensionBusy}
                    onClick={() => void removeSavedExtensions(ref.path)}
                  >
                    {t("removeExtension")}
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              variant="outline"
              disabled={extensionBusy}
              onClick={() => void removeSavedExtensions()}
            >
              {t("clearExtensions")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("extensionsRemovalHint")}</p>
          </div>
        )}
        <Label htmlFor="runtime-extension-path">{t("extensionPath")}</Label>
        <Input
          id="runtime-extension-path"
          value={extensionPath}
          onChange={(event) => setExtensionPath(event.target.value)}
          disabled={!extensionsSupported || extensionBusy}
        />
        <div className="flex items-center gap-2">
          <Switch
            id="runtime-extension-cache"
            checked={preservePromptCache}
            onCheckedChange={setPreservePromptCache}
            disabled={extensionBusy}
          />
          <Label htmlFor="runtime-extension-cache">{t("preservePromptCache")}</Label>
        </div>
        <Button
          onClick={() => void addExtension()}
          disabled={
            !desktop ||
            !activeSessionId ||
            !extensionsSupported ||
            extensionBusy ||
            !extensionPath.trim()
          }
        >
          {t("addExtension")}
        </Button>
        {!extensionsSupported && (
          <p className="text-xs text-muted-foreground">{t("extensionsUnsupported")}</p>
        )}
        {extensionResult && (
          <p role="status">
            {extensionResult === "removed"
              ? t("extensionsRemoved")
              : t(`extensionResult.${extensionResult}`)}
          </p>
        )}
      </SettingsBlock>

      <SdkParityCard />

      <CliSyncCard />
    </SettingsStack>
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
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="h-auto justify-start rounded-none bg-background p-3 text-left font-normal hover:bg-accent focus:bg-accent"
      data-testid={testId}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate font-mono text-sm">{display}</p>
    </Button>
  )
}

export default SidecarTab
