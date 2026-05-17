/**
 * Shared lucide icon map for the visual workflow editor's nodes. Lifted out
 * of `components/workflow/editor/nodes/workflow-node.tsx` so the unified
 * node component AND the Spotlight search results both render the same
 * iconography for any given `WorkflowNodeKind`.
 *
 * Pure data — no React, no DOM. Callers import `getNodeIcon(kind)` and
 * render the returned `LucideIcon` directly.
 */

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
import type { WorkflowNodeKind } from "@/types/workflow/visual"

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

export const FALLBACK_NODE_ICON: LucideIcon = WorkflowIcon

export function getNodeIcon(kind: WorkflowNodeKind | undefined | null): LucideIcon {
  if (!kind) return FALLBACK_NODE_ICON
  return ICONS[kind] ?? FALLBACK_NODE_ICON
}
