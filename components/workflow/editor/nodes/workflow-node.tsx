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
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { workflowNodeCategory, type WorkflowNodeKind } from "@/types/workflow/visual"
import type { WorkflowNodeData } from "@/types/workflow/visual"

const ICONS: Partial<Record<WorkflowNodeKind, LucideIcon>> = {
  "trigger.manual": PlayIcon,
  "trigger.cron": ClockIcon,
  "trigger.connector.inbound": InboxIcon,
  "trigger.chat.message": MessageIcon,
  "trigger.webhook": WebhookIcon,
  "action.character.send": SendIcon,
  "action.character.create": UsersIcon,
  "action.character.update": UsersIcon,
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

  return (
    <div
      className={cn(
        "group relative min-w-[200px] max-w-[280px] rounded-md border-2 bg-card text-card-foreground shadow-sm transition-shadow",
        CATEGORY_COLORS[category],
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        data.disabled && "opacity-50",
        isAnnotation && "italic"
      )}
      data-testid={`wf-node-${data.kind}`}
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
          <div className="text-sm font-medium truncate text-foreground">{data.label}</div>
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
