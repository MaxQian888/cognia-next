"use client"

// Bottom toolbar of the composer — a status line, not a control panel.
//
// It used to inline every tier at once: model, effort, permission, sandbox,
// enhance, web search, skills, agent mode, two plugin slots, quick actions,
// "⋯", and context usage — a dozen controls under the input box. Of those,
// exactly two answer the question a user asks before every turn ("what will
// this run as"), so those two stay: the model chip (carrying its effort
// qualifier) and the permission chip, with the context ring beside them.
//
// Turn capabilities (enhance, web search, skills) live under the composer's `+`
// on both desktop and mobile. This toolbar's "⋯" is reserved for session-shape
// controls (sandbox, agent mode, external agent, runtime) and plugin slots.

import { useCallback, useRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { MoreHorizontalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useElementWidth } from "@/hooks/use-element-width"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"
import { ContextUsageIndicator } from "@/components/chat/context-usage-indicator"
import { useSdkContextUsage } from "@/hooks/chat/use-sdk-context-usage"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"
import { PermissionModeIndicator } from "../permission-mode-indicator"
import { ModelPicker } from "./model-picker"
import { SandboxShield } from "./sandbox-shield"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { AgentModeSelector } from "@/components/agent/mode/mode-selector"
import { ExternalAgentSelector } from "@/components/agent/external-agent/selector"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { PluginExtensionSlotWithOverflow } from "@/components/plugins/plugin-extension-slot-with-overflow"
import { PluginQuickActionsMenu } from "./plugin-quick-actions-menu"
import { WorkflowBottomToolbar } from "./workflow-bottom-toolbar"

interface BottomToolbarProps {
  session: ChatSession | null
  variant?: "default" | "embedded"
}

export function BottomToolbar({ session, variant = "default" }: BottomToolbarProps) {
  // The workflow-editor session is the same discriminator that
  // `resolveSendOptions` keys on to inject workflow subagents + the graph
  // snapshot. The composer surface deserves the same scoping: the generic
  // runtime / mode / external-agent / web-search / generic-skills / generic
  // plugin-slot controls have no useful meaning inside a workflow chat.
  if (session?.kind === "workflow-editor") {
    if (variant === "embedded") {
      return (
        <div className="min-w-0 flex-1" data-testid="composer-toolbar-embedded">
          <WorkflowBottomToolbar session={session} />
        </div>
      )
    }
    return <WorkflowBottomToolbar session={session} />
  }
  return <GenericBottomToolbar session={session} variant={variant} />
}

function GenericBottomToolbar({ session, variant = "default" }: BottomToolbarProps) {
  const t = useTranslations("chat.composer.toolbar")
  const router = useRouter()
  const status = useChatStore((s) => s.status)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarWidth = useElementWidth(rootRef)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const modeId = useAgentRuntimeStore((s) => s.modeId)
  const setModeId = useAgentRuntimeStore((s) => s.setModeId)
  const runtime = useAgentRuntimeStore((s) => s.runtime)
  const externalAgentId = useAgentRuntimeStore((s) => s.externalAgentId)
  const setExternalAgentId = useAgentRuntimeStore((s) => s.setExternalAgentId)

  // Disable toolbar controls while a turn is in flight so mid-stream
  // configuration changes (model, runtime, mode, etc.) can't race the send.
  const isStreaming = status === "streaming" || status === "awaiting_approval"

  // Bridge externalAgentId between the runtime store (toolbar source of truth)
  // and the external-agent store (consumed by the execution layer). The two
  // stores track the active agent independently; this callback keeps them in sync.
  const handleExternalAgentChange = useCallback(
    (agentId: string | null) => {
      setExternalAgentId(agentId)
      useExternalAgentStore.getState().setActiveAgent(agentId)
    },
    [setExternalAgentId]
  )

  // Mirrors `lib/claude/build-options.ts` model resolution: per-session
  // override > app default. (Character / member overrides aren't loaded
  // here — the user-facing display is the most-likely-active value.)
  const modelId = session?.model ?? defaultModel ?? "claude-sonnet-4-5"
  const providerId = session?.providerOverride ?? defaultProvider ?? "anthropic"

  // SDK-authoritative context usage for the live session (Anthropic + desktop
  // only; falls back to the message-derived estimate inside the indicator).
  const { snapshot: sdkUsage } = useSdkContextUsage(session?.id ?? null, providerId)

  // The measured width now only decides how the same set of controls is
  // packed, not which of them exist — every branch renders the identical
  // roster, so no control mounts in two places. (That invariant is why the
  // overflow is a Popover: re-mounting a trigger-owning control inside a
  // `DropdownMenuItem` desyncs its open state.) `toolbarWidth === 0`
  // (pre-measure) takes the wide branch, matching the common chat pane.
  const compact = toolbarWidth > 0 && toolbarWidth < COMPACT_TOOLBAR_PX
  const tierActive = runtime !== "claude-sdk"

  // Runtime is overflow-by-default: most sessions stay on `claude-sdk`, so the
  // runtime switch lives in the "⋯ More" menu rather than the primary row.
  const runtimeControl = <AgentRuntimeSelector disabled={isStreaming} />

  const tier3 = (
    <>
      {runtime === "claude-sdk" && (
        <AgentModeSelector
          selectedModeId={modeId}
          onModeChange={(mode) => setModeId(mode.id)}
          onSelectTeam={(teamId) =>
            router.push(`/agent-teams/workspace?teamId=${encodeURIComponent(teamId)}`)
          }
          onCreateTeam={() => router.push("/agent-teams")}
          disabled={isStreaming}
        />
      )}
      {runtime === "external" && (
        <ExternalAgentSelector
          selectedAgentId={externalAgentId}
          onAgentChange={handleExternalAgentChange}
          disabled={isStreaming}
        />
      )}
      <SandboxShield session={session} />
    </>
  )

  // Plugin-contributed composer actions. Each renders arbitrary plugin UI,
  // often with its own trigger, and this Popover is the container already
  // proven safe for that. All three self-hide when no plugin contributes, so
  // the default install pays nothing for them.
  const pluginSlots = (
    <>
      <PluginExtensionSlotWithOverflow
        point="chat.input.actions"
        limit={3}
        className="flex items-center gap-1 empty:hidden"
        overflowLabel={t("pluginExtensionOverflow")}
      />
      {/* ADR-0026 §3 §C — composer dropdown groups. Distinct from */}
      {/* chat.input.actions (flat buttons) so plugins can ship grouped */}
      {/* quick actions under a single trigger. */}
      <PluginExtensionSlotWithOverflow
        point="chat.input.menu"
        limit={3}
        className="flex items-center gap-1 empty:hidden"
        overflowLabel={t("pluginExtensionOverflow")}
      />
      {/* Declarative quick actions (manifest `quickActions[]` /
          ctx.quickActions) — renders nothing when no plugin
          contributed composer-surface actions. */}
      <PluginQuickActionsMenu disabled={isStreaming} />
    </>
  )

  // The permanent row: what this turn will run as, and nothing else. Model
  // carries its effort qualifier inside its own picker; the sandbox shield,
  // agent mode and runtime moved into "⋯". `flex-nowrap` + `min-w-0` lets a
  // long provider model id ellipsize instead of wrapping the row.
  const tier1Group = (
    <div className="flex min-w-0 flex-nowrap items-center gap-x-2">
      <ModelPicker session={session} disabled={isStreaming} />
      <PermissionModeIndicator onCycle={(next) => setPermissionMode(next)} disabled={isStreaming} />
    </div>
  )

  const contextIndicator = (
    <ContextUsageIndicator
      modelId={modelId}
      providerId={providerId}
      sdkUsage={sdkUsage}
      triggerClassName="ml-auto shrink-0"
    />
  )

  // Everything that is not "what will this turn run as". A Popover, not a
  // DropdownMenu: the agent-mode / external-agent selectors and the plugin
  // slots own their own overlays, and re-mounting those inside a
  // `DropdownMenuItem` desyncs their open state.
  const overflow = (
    <ToolbarMoreMenu label={t("moreControls")} active={tierActive} disabled={isStreaming}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">{tier3}</div>
        <div className="flex flex-wrap items-center gap-2">{runtimeControl}</div>
        <div className="flex flex-wrap items-center gap-2">{pluginSlots}</div>
      </div>
    </ToolbarMoreMenu>
  )

  // All three layouts now agree: [model · effort] [permission] … [context] [⋯].
  // The variants differ only in how the row is packed, not in what it holds.
  if (variant === "embedded") {
    return (
      <div
        ref={rootRef}
        className="flex min-w-0 flex-1 items-center justify-end gap-1 text-[11px] text-muted-foreground"
        data-testid="composer-toolbar-embedded"
      >
        {tier1Group}
        {contextIndicator}
        {overflow}
      </div>
    )
  }

  // Compact (mobile / narrow workflow sidebar): two rows at most — Tier 1 on
  // the first, context usage + overflow sharing the second.
  if (compact) {
    return (
      <div
        ref={rootRef}
        className="mt-2 flex flex-col gap-1 px-1 text-[11px] text-muted-foreground"
      >
        {tier1Group}
        <div className="flex items-center justify-between gap-x-2">
          {contextIndicator}
          {overflow}
        </div>
      </div>
    )
  }

  // Wide (web / desktop): one row, context usage pinned right via `ml-auto`.
  return (
    <div
      ref={rootRef}
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-muted-foreground"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{tier1Group}</div>
      {contextIndicator}
      {overflow}
    </div>
  )
}

/** Below this measured toolbar width, Tier 2 / 3 collapse into the More menu. */
const COMPACT_TOOLBAR_PX = 448

/**
 * Compact "⋯ More" popover holding the toolbar controls that don't fit on a
 * narrow composer (e.g. inside the workflow chat sidebar). A `Popover` — not a
 * `DropdownMenu` — so the nested popover-trigger controls inside it keep their
 * own open-state (Radix's DismissableLayer stack handles the nesting).
 */
function ToolbarMoreMenu({
  label,
  active,
  disabled,
  children,
}: {
  label: string
  active: boolean
  disabled: boolean
  children: ReactNode
}) {
  const isMobile = usePlatform() === "mobile"
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          data-testid="composer-toolbar-more"
          className={cn("relative size-7", isMobile && "touch-target")}
        >
          <MoreHorizontalIcon className="size-3.5" />
          {active && (
            <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-auto max-w-[80vw] p-2">
        {children}
      </PopoverContent>
    </Popover>
  )
}
