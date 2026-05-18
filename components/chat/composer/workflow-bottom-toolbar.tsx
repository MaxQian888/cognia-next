"use client"

/**
 * Workflow-editor variant of the composer's bottom toolbar.
 *
 * Selected by `BottomToolbar` when `session.kind === "workflow-editor"` —
 * the same key `lib/claude/build-options.ts:resolveSendOptions` keys on.
 *
 * The generic toolbar's runtime / mode / external-agent / generic-skill /
 * plugin-slot controls are not surfaced here: the workflow session is
 * server-side already wired with the 4 workflow subagents + `wf_*` MCP
 * tools, so those controls have no useful meaning in this context.
 *
 * What stays:
 *   • ModelPicker            — the user still picks the model.
 *   • PermissionModeIndicator — wf_* tools respect permission mode.
 *   • Context gauge          — token-window read-out, always pinned right.
 *
 * What's added (workflow-specific quick actions):
 *   • Validate  — runs the local zod validator on the editor's current
 *                 graph and feeds the result to the chat as a user prompt
 *                 so the agent can suggest fixes.
 *   • Explain   — explain the currently-selected nodes. Disabled when
 *                 selection is empty.
 *   • Suggest   — ask the workflow-designer subagent for the next node.
 *
 * The quick-action button labels collapse to icon-only at
 * `@max-xs/composer` (≈240px) so a narrow right-sidebar (the editor
 * allows down to 18% of viewport) doesn't crowd the toolbar. Tier-1
 * controls always stay visible.
 */

import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { CheckCircle2Icon, HelpCircleIcon, LightbulbIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
import { ModelPicker } from "./model-picker"
import {
  useWorkflowEditor,
  type WorkflowEditorContextValue,
  type WorkflowQuickActionKind,
} from "@/lib/workflow/editor/workflow-editor-context"
import type { EditorState } from "@/lib/workflow/editor/store"

interface WorkflowBottomToolbarProps {
  session: ChatSession | null
}

export function WorkflowBottomToolbar({ session }: WorkflowBottomToolbarProps) {
  const t = useTranslations("chat.composer.toolbar")
  const messages = useChatStore((s) => s.messages)
  const status = useChatStore((s) => s.status)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const ctx = useWorkflowEditor()

  const isStreaming = status === "streaming" || status === "awaiting_approval"

  // Mirrors the generic toolbar's model resolution: per-session override
  // > app default. Character / member overrides aren't relevant for the
  // workflow-editor session kind.
  const modelId = session?.model ?? defaultModel ?? "claude-sonnet-4-5"
  const usage = getLatestUsage(messages)
  const used = usage ? tokensInWindow(usage) : 0
  const max = getModelContextWindow(modelId)

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
        <ModelPicker session={session} disabled={isStreaming} />
        <PermissionModeIndicator
          onCycle={(next) => setPermissionMode(next)}
          disabled={isStreaming}
        />
        {ctx ? (
          <QuickActions ctx={ctx} disabled={isStreaming} />
        ) : // Render nothing rather than a row of permanently-disabled buttons:
        // the workflow toolbar should not be mounted outside a provider
        // anyway, but if it ever is we don't want dead UI.
        null}
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

function QuickActions({ ctx, disabled }: { ctx: WorkflowEditorContextValue; disabled: boolean }) {
  const tw = useTranslations("chat.composer.toolbar.workflow")
  const selectionCount = ctx.useEditorStore(
    useShallow((s: EditorState) => s.selectedNodeIds.length)
  )

  const dispatch = (kind: WorkflowQuickActionKind) => {
    void ctx.onQuickAction(kind)
  }

  const explainDisabled = disabled || selectionCount === 0

  return (
    <div className="flex items-center gap-1" data-testid="workflow-quick-actions">
      <QuickActionButton
        icon={<CheckCircle2Icon className="size-3.5" />}
        label={tw("validate")}
        ariaLabel={tw("validateAria")}
        tooltip={tw("validateTooltip")}
        disabled={disabled}
        testId="workflow-quick-action-validate"
        onClick={() => dispatch("validate")}
      />
      <QuickActionButton
        icon={<HelpCircleIcon className="size-3.5" />}
        label={tw("explain")}
        ariaLabel={tw("explainAria")}
        tooltip={
          selectionCount === 0
            ? tw("explainNoSelection")
            : tw("explainTooltip", { count: selectionCount })
        }
        disabled={explainDisabled}
        testId="workflow-quick-action-explain"
        onClick={() => dispatch("explain")}
      />
      <QuickActionButton
        icon={<LightbulbIcon className="size-3.5" />}
        label={tw("suggest")}
        ariaLabel={tw("suggestAria")}
        tooltip={tw("suggestTooltip")}
        disabled={disabled}
        testId="workflow-quick-action-suggest"
        onClick={() => dispatch("suggest")}
      />
    </div>
  )
}

function QuickActionButton({
  icon,
  label,
  ariaLabel,
  tooltip,
  disabled,
  testId,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  ariaLabel: string
  tooltip: string
  disabled: boolean
  testId: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onClick}
          aria-label={ariaLabel}
          data-testid={testId}
          className="h-6 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
        >
          {icon}
          <span className="@max-xs/composer:hidden">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
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
