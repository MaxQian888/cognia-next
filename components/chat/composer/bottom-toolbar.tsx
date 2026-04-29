"use client"

// Bottom toolbar of the composer. Surfaces session metadata that doesn't
// fit on the inline button row: the resolved model id (read-only — the
// real switch lives in Settings), the active permission mode, and the
// running token / context-window indicator.

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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useChatStore } from "@/stores/chat-store"
import { useSettingsStore } from "@/stores/settings-store"
import type { ChatSession } from "@/lib/claude/types"
import { getLatestUsage, getModelContextWindow, tokensInWindow } from "@/lib/usage"
import type { LanguageModelUsage } from "ai"
import { CpuIcon } from "lucide-react"
import { PermissionModeIndicator } from "../permission-mode-indicator"
import { WebSearchToggle } from "./web-search-toggle"
import { AgentRuntimeSelector } from "@/components/agent/agent-runtime-selector"
import { AgentModeSelector } from "@/components/agent/agent-mode-selector"
import { useAgentRuntimeStore } from "@/stores/agent-runtime-store"

interface BottomToolbarProps {
  session: ChatSession | null
}

export function BottomToolbar({ session }: BottomToolbarProps) {
  const messages = useChatStore((s) => s.messages)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const modeId = useAgentRuntimeStore((s) => s.modeId)
  const setModeId = useAgentRuntimeStore((s) => s.setModeId)
  const runtime = useAgentRuntimeStore((s) => s.runtime)

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
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 truncate">
              <CpuIcon className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{modelId}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Active model · change in Settings → API Key</TooltipContent>
        </Tooltip>
        <PermissionModeIndicator onCycle={(next) => setPermissionMode(next)} />
        <WebSearchToggle />
        <AgentRuntimeSelector />
        {runtime === "claude-sdk" && (
          <AgentModeSelector selectedModeId={modeId} onModeChange={(mode) => setModeId(mode.id)} />
        )}
      </div>

      <Context maxTokens={max} modelId={modelId} usage={aiUsage} usedTokens={used}>
        <ContextTrigger className="h-6 gap-1.5 px-1.5 text-[11px] font-normal" />
        <ContextContent>
          <ContextContentHeader />
          <ContextContentBody>
            <div className="space-y-1.5">
              <UsageRow label="Input" slot={<ContextInputUsage />} />
              <UsageRow label="Output" slot={<ContextOutputUsage />} />
              <UsageRow label="Cached" slot={<ContextCacheUsage />} />
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
