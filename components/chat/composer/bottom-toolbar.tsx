"use client"

// Bottom toolbar of the composer. Surfaces session metadata that doesn't
// fit on the inline button row: the resolved model id (read-only — the
// real switch lives in Settings), the active permission mode, and the
// running token / context-window indicator.

import { useCallback, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { MoreHorizontalIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useElementWidth } from "@/hooks/use-element-width"
import { SkillPicker } from "@/components/chat/skill-picker"
import { ContextUsageIndicator } from "@/components/chat/context-usage-indicator"
import { useSdkContextUsage } from "@/hooks/chat/use-sdk-context-usage"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@/lib/claude/types"
import { PermissionModeIndicator } from "../permission-mode-indicator"
import { WebSearchToggle } from "./web-search-toggle"
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
import { EnhanceButton } from "./enhance-button"
import { usePromptInputController } from "@/components/ai-elements/prompt-input"

interface BottomToolbarProps {
  session: ChatSession | null
}

export function BottomToolbar({ session }: BottomToolbarProps) {
  // The workflow-editor session is the same discriminator that
  // `resolveSendOptions` keys on to inject workflow subagents + the graph
  // snapshot. The composer surface deserves the same scoping: the generic
  // runtime / mode / external-agent / web-search / generic-skills / generic
  // plugin-slot controls have no useful meaning inside a workflow chat.
  if (session?.kind === "workflow-editor") {
    return <WorkflowBottomToolbar session={session} />
  }
  return <GenericBottomToolbar session={session} />
}

function GenericBottomToolbar({ session }: BottomToolbarProps) {
  const t = useTranslations("chat.composer.toolbar")
  const router = useRouter()
  const status = useChatStore((s) => s.status)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const ephemeralSkillIds = useChatStore((s) => s.ephemeralSkillIds) ?? []
  const setEphemeralSkillIds = useChatStore((s) => s.setEphemeralSkillIds) ?? (() => {})
  const webSearchOn = useChatStore((s) => s.webSearchOnForNextSend) ?? false
  const [pickerOpen, setPickerOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarWidth = useElementWidth(rootRef)
  const tSkill = useTranslations("skills.composer.skillPicker")
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const enhanceEnabled = useSettingsStore(
    (s) => s.settings?.composerAssistance?.enhance?.enabled !== false
  )
  const controller = usePromptInputController()
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

  // Responsive tiers. Tier 1 (Model / Permission / Sandbox / Context) is
  // always inline. Tier 2 (Enhance / Web search / Skills) and Tier 3
  // (AgentRuntime / AgentMode / ExternalAgent / plugin slots) render inline
  // when the toolbar is wide enough, and collapse into a single "⋯ More"
  // popover below `COMPACT_TOOLBAR_PX`. The switch is driven by the measured
  // toolbar width (not a CSS container query) so each control mounts in
  // EXACTLY ONE place — re-mounting these popover-trigger controls inside a
  // DropdownMenuItem would desync their open-state, which is why they used to
  // be hidden outright. `toolbarWidth === 0` (pre-measure) renders inline,
  // matching the common full-width chat pane.
  const compact = toolbarWidth > 0 && toolbarWidth < COMPACT_TOOLBAR_PX
  const tierActive = webSearchOn || ephemeralSkillIds.length > 0 || runtime !== "claude-sdk"

  const tier2 = (
    <>
      {enhanceEnabled && (
        <EnhanceButton
          value={controller.textInput.value}
          onApply={(next) => controller.textInput.setInput(next)}
          session={session}
          disabled={isStreaming}
        />
      )}
      <WebSearchToggle disabled={isStreaming} />
      <Button
        type="button"
        size="icon"
        variant={ephemeralSkillIds.length > 0 ? "default" : "ghost"}
        onClick={() => setPickerOpen(true)}
        aria-label={tSkill("trigger")}
        disabled={isStreaming}
        className="size-7"
      >
        <SparklesIcon className="size-3.5" />
      </Button>
    </>
  )

  const tier3 = (
    <>
      <AgentRuntimeSelector disabled={isStreaming} />
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

  return (
    <div
      ref={rootRef}
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-muted-foreground"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ModelPicker session={session} disabled={isStreaming} />
        <PermissionModeIndicator
          onCycle={(next) => setPermissionMode(next)}
          disabled={isStreaming}
        />
        <SandboxShield session={session} />
        {!compact && (
          <>
            <div className="flex items-center gap-2">{tier2}</div>
            <div className="flex items-center gap-2">{tier3}</div>
          </>
        )}
        {compact && (
          <ToolbarMoreMenu label={t("moreControls")} active={tierActive} disabled={isStreaming}>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">{tier2}</div>
              <div className="flex flex-wrap items-center gap-2">{tier3}</div>
            </div>
          </ToolbarMoreMenu>
        )}
        {/* The SkillPicker dialog stays mounted regardless of tier so the */}
        {/* trigger inside `tier2` (inline or in the More menu) can open it. */}
        <SkillPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          value={ephemeralSkillIds}
          onChange={setEphemeralSkillIds}
        />
      </div>

      <ContextUsageIndicator
        modelId={modelId}
        providerId={providerId}
        sdkUsage={sdkUsage}
        triggerClassName="ml-auto shrink-0"
      />
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
          className="relative size-7"
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
