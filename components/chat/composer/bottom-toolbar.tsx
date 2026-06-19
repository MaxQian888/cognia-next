"use client"

// Bottom toolbar of the composer. Surfaces session metadata that doesn't
// fit on the inline button row: the resolved model id (read-only — the
// real switch lives in Settings), the active permission mode, and the
// running token / context-window indicator.

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
  const [pickerOpen, setPickerOpen] = useState(false)
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

  // Responsive tiers (driven by the `@container/composer` declared on the
  // composer's outer wrapper):
  //   • Tier 1 — Model / Permission / Context — always visible.
  //   • Tier 2 — Web search / Skills — hidden below @sm/composer (~420px).
  //   • Tier 3 — AgentRuntime / AgentMode / ExternalAgent / Plugin slot —
  //     hidden below @md/composer (~560px).
  // Below those thresholds the controls are intentionally hidden, not
  // collapsed into a "More" menu: most of them are popovers in their own
  // right and re-mounting them inside a DropdownMenuItem would desync
  // their open-state. The user can resize the panel, or change the
  // affected setting from Settings → Agent runtime / Web search / Skills.
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ModelPicker session={session} disabled={isStreaming} />
        <PermissionModeIndicator
          onCycle={(next) => setPermissionMode(next)}
          disabled={isStreaming}
        />
        <SandboxShield session={session} />
        <div className="hidden items-center gap-2 @sm/composer:flex">
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
        </div>
        <SkillPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          value={ephemeralSkillIds}
          onChange={setEphemeralSkillIds}
        />
        <div className="hidden items-center gap-2 @md/composer:flex">
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
        </div>
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
