"use client"

// Bottom toolbar of the composer. Surfaces session metadata that doesn't
// fit on the inline button row: the resolved model id (read-only — the
// real switch lives in Settings), the active permission mode, and the
// running token / context-window indicator.

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextCacheUsage,
  ContextTrigger,
} from "@/components/ai-elements/context"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@/lib/claude/types"
import { getLatestUsage, getModelContextWindow, tokensInWindow } from "@/lib/claude/usage"
import type { LanguageModelUsage } from "ai"
import { PermissionModeIndicator } from "../permission-mode-indicator"
import { WebSearchToggle } from "./web-search-toggle"
import { ModelPicker } from "./model-picker"
import { AgentRuntimeSelector } from "@/components/agent/agent-runtime-selector"
import { AgentModeSelector } from "@/components/agent/agent-mode-selector"
import { ExternalAgentSelector } from "@/components/agent/external-agent-selector"
import { useAgentRuntimeStore } from "@/stores/agent"

interface BottomToolbarProps {
  session: ChatSession | null
}

export function BottomToolbar({ session }: BottomToolbarProps) {
  const t = useTranslations("chat.composer.toolbar")
  const router = useRouter()
  const messages = useChatStore((s) => s.messages)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const modeId = useAgentRuntimeStore((s) => s.modeId)
  const setModeId = useAgentRuntimeStore((s) => s.setModeId)
  const runtime = useAgentRuntimeStore((s) => s.runtime)
  const externalAgentId = useAgentRuntimeStore((s) => s.externalAgentId)
  const setExternalAgentId = useAgentRuntimeStore((s) => s.setExternalAgentId)

  // Mirrors `lib/claude/build-options.ts` model resolution: per-session
  // override > app default. (Character / member overrides aren't loaded
  // here — the user-facing display is the most-likely-active value.)
  const modelId = session?.model ?? defaultModel ?? "claude-sonnet-4-5"
  const usage = getLatestUsage(messages)
  const used = usage ? tokensInWindow(usage) : 0
  const max = getModelContextWindow(modelId)

  // Map `UsageInfo` (snake-cased upstream, camelCased here) to the
  // LanguageModelUsage shape the AI Elements `<Context>` consumes.
  const aiUsage: LanguageModelUsage | undefined = usage
    ? ({
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.cacheReadInputTokens ?? 0,
        totalTokens:
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
      } as unknown as LanguageModelUsage)
    : undefined

  return (
    <div className="mt-2 flex items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <ModelPicker session={session} />
        <PermissionModeIndicator onCycle={(next) => setPermissionMode(next)} />
        <WebSearchToggle />
        <AgentRuntimeSelector />
        {runtime === "claude-sdk" && (
          <AgentModeSelector
            selectedModeId={modeId}
            onModeChange={(mode) => setModeId(mode.id)}
            onSelectTeam={(teamId) => router.push(`/agent-teams/${teamId}`)}
            onCreateTeam={() => router.push("/agent-teams")}
          />
        )}
        {runtime === "external" && (
          <ExternalAgentSelector
            selectedAgentId={externalAgentId}
            onAgentChange={setExternalAgentId}
          />
        )}
      </div>

      <Context maxTokens={max} modelId={modelId} usage={aiUsage} usedTokens={used}>
        <ContextTrigger className="h-6 gap-1.5 px-1.5 text-[11px] font-normal" />
        <ContextContent>
          <ContextContentHeader />
          <ContextContentBody>
            <div className="space-y-1.5">
              <UsageRow label={t("usageInput")} slot={<ContextInputUsage />} />
              <UsageRow label={t("usageOutput")} slot={<ContextOutputUsage />} />
              <UsageRow label={t("usageCached")} slot={<ContextCacheUsage />} />
            </div>
          </ContextContentBody>
          <ContextContentFooter />
        </ContextContent>
      </Context>
    </div>
  )
}

function UsageRow({ label, slot }: { label: string; slot: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{slot}</span>
    </div>
  )
}
