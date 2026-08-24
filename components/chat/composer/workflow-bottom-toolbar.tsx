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
 *   • EffortChip             — and how deeply it thinks. It rides beside the
 *                              model here for the same reason it does on the
 *                              generic toolbar: the chip is the thinking
 *                              level's only surface, so a composer without it
 *                              cannot reach the setting at all.
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
 * `@max-sm/composer` (≈384px) so a narrow right-sidebar (the editor
 * allows down to 18% of viewport) doesn't crowd the toolbar; the row
 * also `flex-wrap`s as a last-resort overflow guard. Tier-1 controls
 * always stay visible.
 */

import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { AtSignIcon, CheckCircle2Icon, HelpCircleIcon, LightbulbIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ContextUsageIndicator } from "@/components/chat/context-usage-indicator"
import { useSdkContextUsage } from "@/hooks/chat/use-sdk-context-usage"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"
import { PermissionModeIndicator } from "../permission-mode-indicator"
import { ModelPicker } from "./model-picker"
import { EffortChip } from "./effort-chip"
import {
  useWorkflowEditor,
  type WorkflowEditorContextValue,
  type WorkflowQuickActionKind,
} from "@/lib/workflow/editor/workflow-editor-context"
import type { EditorState } from "@/lib/workflow/editor/store"
import { buildMentionableWorkflowElements } from "@/lib/workflow/editor/use-mentionable-workflow-elements"
import { dispatchWorkflowSlashAction } from "@/lib/slash-commands/actions/workflow"
import { useComposerSessionId } from "./composer-session-context"

interface WorkflowBottomToolbarProps {
  session: ChatSession | null
}

export function WorkflowBottomToolbar({ session }: WorkflowBottomToolbarProps) {
  const status = useChatStore((s) => s.status)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const composerSessionId = useComposerSessionId()
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const ctx = useWorkflowEditor()

  const isStreaming = status === "streaming" || status === "awaiting_approval"

  // Mirrors the generic toolbar's model resolution: per-session override
  // > app default. Character / member overrides aren't relevant for the
  // workflow-editor session kind.
  const modelId = session?.model ?? defaultModel ?? ANTHROPIC_DEFAULT_MODEL
  const providerId = session?.providerOverride ?? defaultProvider ?? "anthropic"

  // SDK-authoritative context usage (Anthropic + desktop only; estimate fallback).
  const { snapshot: sdkUsage } = useSdkContextUsage(session?.id ?? null, providerId)

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ModelPicker session={session} disabled={isStreaming} />
        <EffortChip session={session} disabled={isStreaming} />
        <PermissionModeIndicator
          onCycle={(next) => setPermissionMode(next, composerSessionId)}
          disabled={isStreaming}
        />
        {ctx ? (
          <QuickActions ctx={ctx} disabled={isStreaming} />
        ) : // Render nothing rather than a row of permanently-disabled buttons:
        // the workflow toolbar should not be mounted outside a provider
        // anyway, but if it ever is we don't want dead UI.
        null}
      </div>

      <ContextUsageIndicator modelId={modelId} providerId={providerId} sdkUsage={sdkUsage} />
    </div>
  )
}

function QuickActions({ ctx, disabled }: { ctx: WorkflowEditorContextValue; disabled: boolean }) {
  const tw = useTranslations("chat.composer.toolbar.workflow")
  const selection = ctx.useEditorStore(
    useShallow((s: EditorState) => ({
      nodes: s.selectedNodeIds.length,
      edges: s.selectedEdgeIds.length,
    }))
  )
  const selectionCount = selection.nodes

  // Stage the current canvas selection as copilot reference chips. Resolved on
  // click via `getState()` (not a reactive subscription) so the toolbar doesn't
  // re-render on every graph edit; a brief pulse confirms the link on-canvas.
  const referenceSelection = () => {
    const st = ctx.useEditorStore.getState()
    const selected = new Set<string>([...st.selectedNodeIds, ...st.selectedEdgeIds])
    if (selected.size === 0) return
    const add = useChatStore.getState().addReferencedWorkflowElement
    for (const el of buildMentionableWorkflowElements(st.nodes, st.edges)) {
      if (selected.has(el.id)) {
        add({ type: el.type, id: el.id, label: el.label, kind: el.kind })
      }
    }
    if (st.selectedNodeIds[0]) st.pulseNode(st.selectedNodeIds[0], 1200)
  }

  const dispatch = (kind: WorkflowQuickActionKind) => {
    // Single dispatch path with the formal slash commands so the button
    // click and `/validate` typed into the composer produce identical
    // behavior. Falls back to the legacy onQuickAction (which the test
    // harness still wires in) when the runtime can't emit DOM events.
    if (kind === "explain") {
      if (!dispatchWorkflowSlashAction({ kind: "explain", args: "" })) {
        void ctx.onQuickAction(kind)
      }
      return
    }
    if (!dispatchWorkflowSlashAction({ kind })) {
      void ctx.onQuickAction(kind)
    }
  }

  const explainDisabled = disabled || selectionCount === 0
  const referenceDisabled = disabled || (selection.nodes === 0 && selection.edges === 0)

  return (
    <div className="flex items-center gap-1" data-testid="workflow-quick-actions">
      <QuickActionButton
        icon={<AtSignIcon className="size-3.5" />}
        label={tw("reference")}
        ariaLabel={tw("referenceAria")}
        tooltip={
          referenceDisabled
            ? tw("referenceNoSelection")
            : tw("referenceTooltip", { count: selection.nodes + selection.edges })
        }
        disabled={referenceDisabled}
        testId="workflow-quick-action-reference"
        onClick={referenceSelection}
      />
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
          <span className="@max-sm/composer:hidden">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
