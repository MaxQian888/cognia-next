"use client"

import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import {
  Webhook as WebhookIcon,
  Clock as ClockIcon,
  PlayCircle as PlayIcon,
  Inbox as InboxIcon,
  MessageSquare as MessageIcon,
  Users as UsersIcon,
  Sparkles as SparklesIcon,
  Bot as BotIcon,
  Brain as BrainIcon,
  GitBranch as BranchIcon,
  Workflow as WorkflowIcon,
  Variable as VariableIcon,
  Repeat as LoopIcon,
  Timer as TimerIcon,
  Code2 as CodeIcon,
  FileText as TemplateIcon,
  ArrowRightLeft as TransformIcon,
  Globe as GlobeIcon,
  StickyNote as NoteIcon,
  Boxes as PluginIcon,
  Network as McpIcon,
  Send as SendIcon,
  PencilLine as DraftIcon,
  Loader2 as LoadingIcon,
  CheckCircle2 as SuccessIcon,
  XCircle as FailedIcon,
  CircleDashed as SkippedIcon,
  AlertTriangle as WarnIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { workflowNodeCategory, type WorkflowNodeKind } from "@/types/workflow/visual"
import type { WorkflowNodeData } from "@/types/workflow/visual"
import type { NodeRunStatus } from "@/lib/workflow/editor/store"

const ICONS: Partial<Record<WorkflowNodeKind, LucideIcon>> = {
  "trigger.manual": PlayIcon,
  "trigger.cron": ClockIcon,
  "trigger.connector.inbound": InboxIcon,
  "trigger.chat.message": MessageIcon,
  "trigger.webhook": WebhookIcon,
  "action.character.send": SendIcon,
  "action.character.create": UsersIcon,
  "action.character.update": UsersIcon,
  "action.agent.turn": BotIcon,
  "action.team.run": UsersIcon,
  "action.team.create": UsersIcon,
  "action.team.update": UsersIcon,
  "action.skill.invoke": SparklesIcon,
  "action.skill.upsert": SparklesIcon,
  "action.twin.rag": BrainIcon,
  "action.twin.ingest": BrainIcon,
  "action.connector.send": SendIcon,
  "action.connector.draft": DraftIcon,
  "action.mcp.invokeTool": McpIcon,
  "action.plugin.invoke": PluginIcon,
  "ai.prompt": BotIcon,
  "ai.classify": BotIcon,
  "ai.extract": BotIcon,
  "ai.embed": BotIcon,
  "flow.branch": BranchIcon,
  "flow.switch": BranchIcon,
  "flow.split": WorkflowIcon,
  "flow.join": WorkflowIcon,
  "flow.loop": LoopIcon,
  "flow.wait": TimerIcon,
  "flow.set": VariableIcon,
  "flow.subworkflow": WorkflowIcon,
  "data.transform": TransformIcon,
  "data.code": CodeIcon,
  "data.template": TemplateIcon,
  "io.http": GlobeIcon,
  "io.webhook.respond": WebhookIcon,
  "annotation.note": NoteIcon,
  "annotation.group": NoteIcon,
}

const CATEGORY_COLORS = {
  trigger: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  action: "border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-300",
  ai: "border-violet-500/40 bg-violet-500/5 text-violet-700 dark:text-violet-300",
  flow: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  data: "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-300",
  io: "border-cyan-500/40 bg-cyan-500/5 text-cyan-700 dark:text-cyan-300",
  annotation: "border-zinc-500/30 bg-zinc-500/5 text-zinc-700 dark:text-zinc-300",
} as const

export type WorkflowNodeRenderData = WorkflowNodeData & {
  kind: WorkflowNodeKind
  typeVersion: number
  /** Live execution status, merged in by the canvas from the run-status bridge. */
  runStatus?: NodeRunStatus
  /** Validation summary lines, merged in by the canvas. Used for the tooltip. */
  validationErrors?: string[]
  /** Number of fields with validation errors. Drives the corner badge count. */
  validationErrorCount?: number
}

const STATUS_RING: Record<NodeRunStatus, string> = {
  idle: "",
  running: "ring-2 ring-amber-500/70 animate-pulse",
  succeeded: "ring-2 ring-emerald-500/70",
  failed: "ring-2 ring-rose-500/70",
  skipped: "ring-2 ring-zinc-500/40 ring-dashed",
  waiting: "ring-2 ring-sky-500/60",
}

function StatusBadge({ status }: { status: NodeRunStatus }) {
  if (status === "running")
    return <LoadingIcon className="size-3.5 text-amber-500 animate-spin" aria-label="Running" />
  if (status === "succeeded")
    return <SuccessIcon className="size-3.5 text-emerald-500" aria-label="Succeeded" />
  if (status === "failed")
    return <FailedIcon className="size-3.5 text-rose-500" aria-label="Failed" />
  if (status === "skipped")
    return <SkippedIcon className="size-3.5 text-zinc-400" aria-label="Skipped" />
  if (status === "waiting")
    return <TimerIcon className="size-3.5 text-sky-500" aria-label="Waiting" />
  return null
}

export const WorkflowNodeComponent = memo(function WorkflowNodeComponent({
  data,
  selected,
}: NodeProps & { data: WorkflowNodeRenderData }) {
  const category = workflowNodeCategory(data.kind)
  const Icon = ICONS[data.kind] ?? WorkflowIcon
  const isAnnotation = category === "annotation"
  const showInput = !data.kind.startsWith("trigger.")
  const showOutput = data.kind !== "annotation.note" && data.kind !== "annotation.group"
  const status: NodeRunStatus = data.runStatus ?? "idle"
  const errorCount = data.validationErrorCount ?? data.validationErrors?.length ?? 0
  const hasErrors = errorCount > 0

  return (
    <div
      className={cn(
        "group relative min-w-[200px] max-w-[280px] rounded-md border-2 bg-card text-card-foreground shadow-sm transition-shadow",
        CATEGORY_COLORS[category],
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        // Status ring takes precedence over selection when present.
        !selected && STATUS_RING[status],
        data.disabled && "opacity-50",
        isAnnotation && "italic"
      )}
      data-testid={`wf-node-${data.kind}`}
      data-run-status={status}
    >
      {showInput ? (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-3 !w-3 !rounded-full !border-2 !border-current !bg-background"
        />
      ) : null}
      <div className="flex items-start gap-2 px-3 py-2.5">
        <Icon className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-medium truncate text-foreground flex-1">{data.label}</div>
            {status !== "idle" ? <StatusBadge status={status} /> : null}
            {hasErrors ? (
              <span
                title={data.validationErrors?.join("\n") ?? `${errorCount} validation issue(s)`}
                className="inline-flex items-center gap-0.5 rounded-full bg-destructive/15 px-1.5 py-px text-[10px] font-semibold text-destructive"
                data-testid="wf-node-error-badge"
              >
                <WarnIcon className="size-3" aria-hidden="true" />
                {errorCount}
              </span>
            ) : null}
          </div>
          <div className="text-[10px] uppercase tracking-wide opacity-70">{data.kind}</div>
          {data.notes ? (
            <div className="mt-1.5 text-xs text-muted-foreground line-clamp-2">{data.notes}</div>
          ) : null}
        </div>
      </div>
      {showOutput ? (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-3 !w-3 !rounded-full !border-2 !border-current !bg-background"
        />
      ) : null}
    </div>
  )
})
