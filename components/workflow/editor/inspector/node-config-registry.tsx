"use client"

/**
 * Per-kind inspector config component registry.
 *
 * Each entry takes a `params` object + `onChange` callback. The inspector
 * shell handles form state via react-hook-form; this registry just maps a
 * kind to the component that renders fields. Kinds without a registered
 * component fall back to a generic JSON editor.
 */

import type { ComponentType } from "react"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { SchemaForm } from "./forms/schema-form"
import {
  DesktopScreenshotConfig,
  DesktopFindElementConfig,
  DesktopReadTreeConfig,
  DesktopClickConfig,
  DesktopTypeConfig,
  DesktopKeysConfig,
  DesktopInvokePatternConfig,
  DesktopWindowFocusConfig,
  DesktopWindowCloseConfig,
  DesktopWindowResizeConfig,
  DesktopWaitConfig,
  DesktopPasteConfig,
  DesktopLaunchAppConfig,
} from "./forms/desktop"
import {
  GithubClosePrConfig,
  GithubCloseIssueConfig,
  GithubCommentIssueConfig,
  GithubCommentPrConfig,
  GithubCreateReleaseConfig,
  GithubGenerateChangelogConfig,
  GithubLabelIssueConfig,
  GithubMergePrConfig,
  GithubOpenPrConfig,
  GithubPushTagConfig,
  GithubReviewPrConfig,
  GithubReviewPrInlineConfig,
  GithubRunIssueLoopConfig,
  GithubWebhookTriggerConfig,
} from "./forms/github-forms"
import {
  GitStageConfig,
  GitCommitConfig,
  GitPushConfig,
  GitBranchConfig,
  OcrExtractConfig,
} from "./forms/git-ocr-forms"
import { EvalRunConfig, EvalGateConfig } from "./forms/eval-forms"
import {
  AgentTurnConfig,
  AiClassifyConfig,
  AiEmbedConfig,
  AiExtractConfig,
  AiPromptConfig,
  EnsembleConfig,
  BranchConfig,
  CatchConfig,
  CharacterCreateConfig,
  CharacterSendConfig,
  CharacterUpdateConfig,
  ChatMessageTriggerConfig,
  CodeConfig,
  ConnectorDraftConfig,
  ConnectorInboundConfig,
  ConnectorSendConfig,
  CronConfig,
  DesktopEventTriggerConfig,
  GenericJsonConfig,
  GoalAnalyticsConfig,
  GoalCompletedTriggerConfig,
  GoalCreateConfig,
  GoalEventsConfig,
  GoalListConfig,
  GoalTemplateCreateGoalConfig,
  GoalTemplateDeleteConfig,
  GoalTemplateFavoriteConfig,
  GoalTemplateListConfig,
  GoalTemplateUpsertConfig,
  PlanCreateConfig,
  PlanEventsConfig,
  PlanListConfig,
  PlanRejectConfig,
  PlanRefineConfig,
  PlanSetStepStatusConfig,
  PlanTransitionConfig,
  PlanUpdateDraftConfig,
  SchedulerExecutionGetConfig,
  SchedulerEventTriggerConfig,
  SchedulerExecutionsRecentConfig,
  SchedulerStatisticsConfig,
  SchedulerStatusConfig,
  SchedulerTaskBackfillConfig,
  SchedulerTaskCreateConfig,
  SchedulerTaskExecutionsConfig,
  SchedulerTaskExportConfig,
  SchedulerTaskIdConfig,
  SchedulerTaskImportConfig,
  SchedulerTaskListConfig,
  SchedulerTaskUpdateConfig,
  SchedulerUpcomingConfig,
  GoalToggleSubgoalConfig,
  GoalTransitionConfig,
  GoalUpdateConfigConfig,
  GoalUpdateObjectiveConfig,
  GroupAnnotationConfig,
  HttpRequestConfig,
  JoinConfig,
  LoopConfig,
  BreakConfig,
  ContinueConfig,
  ManualTriggerConfig,
  McpInvokeToolConfig,
  MemoryRecallConfig,
  MemoryStoreConfig,
  NoteConfig,
  PluginInvokeConfig,
  SetVariableConfig,
  SkillInvokeConfig,
  SkillUpsertConfig,
  SplitConfig,
  SubworkflowConfig,
  SwitchConfig,
  SystemTerminalConfig,
  TerminalCommandTriggerConfig,
  TerminalReadRecentConfig,
  TerminalScriptConfig,
  TerminalSessionCloseConfig,
  TerminalSessionOpenConfig,
  TerminalSessionRunConfig,
  TerminalWaitForExitConfig,
  TeamCreateConfig,
  TeamRunConfig,
  TeamTaskDispatchConfig,
  TeamTriggerConfig,
  TeamUpdateConfig,
  TemplateConfig,
  TransformConfig,
  AggregateConfig,
  TwinIngestConfig,
  TwinRagConfig,
  WaitConfig,
  WebhookRespondConfig,
  WebhookTriggerConfig,
  OutputConfig,
} from "./forms"

export type NodeConfigComponent = ComponentType<{
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** Node's params generation — v2-aware forms (branch/switch) dispatch on it. */
  typeVersion?: number
}>

const REGISTRY: Partial<Record<WorkflowNodeKind, NodeConfigComponent>> = {
  // Triggers
  "trigger.manual": ManualTriggerConfig,
  "trigger.cron": CronConfig,
  "trigger.connector.inbound": ConnectorInboundConfig,
  "trigger.chat.message": ChatMessageTriggerConfig,
  "trigger.goal.completed": GoalCompletedTriggerConfig,
  "trigger.webhook": WebhookTriggerConfig,
  "trigger.team": TeamTriggerConfig,
  "trigger.desktop.event": DesktopEventTriggerConfig,
  // Actions: characters
  "action.character.send": CharacterSendConfig,
  "action.character.create": CharacterCreateConfig,
  "action.character.update": CharacterUpdateConfig,
  // Actions: agent
  "action.agent.turn": AgentTurnConfig,
  // Actions: goals
  "action.goal.create": GoalCreateConfig,
  "action.goal.get": GoalTransitionConfig,
  "action.goal.list": GoalListConfig,
  "action.goal.events": GoalEventsConfig,
  "action.goal.updateObjective": GoalUpdateObjectiveConfig,
  "action.goal.pause": GoalTransitionConfig,
  "action.goal.resume": GoalTransitionConfig,
  "action.goal.stop": GoalTransitionConfig,
  "action.goal.preempt": GoalTransitionConfig,
  "action.goal.updateConfig": GoalUpdateConfigConfig,
  "action.goal.decomposeSubgoals": GoalTransitionConfig,
  "action.goal.toggleSubgoal": GoalToggleSubgoalConfig,
  "action.goal.clearSubgoals": GoalTransitionConfig,
  "action.goal.delete": GoalTransitionConfig,
  "action.goal.analytics": GoalAnalyticsConfig,
  "action.goal.template.list": GoalTemplateListConfig,
  "action.goal.template.createGoal": GoalTemplateCreateGoalConfig,
  "action.goal.template.upsert": GoalTemplateUpsertConfig,
  "action.goal.template.favorite": GoalTemplateFavoriteConfig,
  "action.goal.template.delete": GoalTemplateDeleteConfig,
  "action.plan.create": PlanCreateConfig,
  "action.plan.get": PlanTransitionConfig,
  "action.plan.list": PlanListConfig,
  "action.plan.events": PlanEventsConfig,
  "action.plan.updateDraft": PlanUpdateDraftConfig,
  "action.plan.approve": PlanTransitionConfig,
  "action.plan.reject": PlanRejectConfig,
  "action.plan.refine": PlanRefineConfig,
  "action.plan.pause": PlanTransitionConfig,
  "action.plan.resume": PlanTransitionConfig,
  "action.plan.cancel": PlanTransitionConfig,
  "action.plan.delete": PlanTransitionConfig,
  "action.plan.run": PlanTransitionConfig,
  "action.plan.setStepStatus": PlanSetStepStatusConfig,
  "action.scheduler.task.create": SchedulerTaskCreateConfig,
  "action.scheduler.task.get": SchedulerTaskIdConfig,
  "action.scheduler.task.list": SchedulerTaskListConfig,
  "action.scheduler.task.update": SchedulerTaskUpdateConfig,
  "action.scheduler.task.pause": SchedulerTaskIdConfig,
  "action.scheduler.task.resume": SchedulerTaskIdConfig,
  "action.scheduler.task.delete": SchedulerTaskIdConfig,
  "action.scheduler.task.runNow": SchedulerTaskIdConfig,
  "action.scheduler.task.executions": SchedulerTaskExecutionsConfig,
  "action.scheduler.task.backfill": SchedulerTaskBackfillConfig,
  "action.scheduler.task.export": SchedulerTaskExportConfig,
  "action.scheduler.task.import": SchedulerTaskImportConfig,
  "action.scheduler.status": SchedulerStatusConfig,
  "action.scheduler.statistics": SchedulerStatisticsConfig,
  "action.scheduler.upcoming": SchedulerUpcomingConfig,
  "action.scheduler.executions.recent": SchedulerExecutionsRecentConfig,
  "action.scheduler.execution.get": SchedulerExecutionGetConfig,
  "action.scheduler.event.trigger": SchedulerEventTriggerConfig,
  // Actions: teams
  "action.team.run": TeamRunConfig,
  "action.team.task.dispatch": TeamTaskDispatchConfig,
  "action.team.create": TeamCreateConfig,
  "action.team.update": TeamUpdateConfig,
  // Actions: skills
  "action.skill.invoke": SkillInvokeConfig,
  "action.skill.upsert": SkillUpsertConfig,
  // Actions: twins
  "action.twin.rag": TwinRagConfig,
  "action.twin.ingest": TwinIngestConfig,
  // Actions: memory
  "action.memory.recall": MemoryRecallConfig,
  "action.memory.store": MemoryStoreConfig,
  // Actions: connectors
  "action.connector.send": ConnectorSendConfig,
  "action.connector.draft": ConnectorDraftConfig,
  // Actions: extensibility
  "action.mcp.invokeTool": McpInvokeToolConfig,
  "action.plugin.invoke": PluginInvokeConfig,
  // Actions: desktop UI automation (forms in ./forms/desktop)
  "action.desktop.screenshot": DesktopScreenshotConfig,
  "action.desktop.findElement": DesktopFindElementConfig,
  "action.desktop.readTree": DesktopReadTreeConfig,
  "action.desktop.click": DesktopClickConfig,
  "action.desktop.type": DesktopTypeConfig,
  "action.desktop.keys": DesktopKeysConfig,
  "action.desktop.invokePattern": DesktopInvokePatternConfig,
  "action.desktop.windowFocus": DesktopWindowFocusConfig,
  "action.desktop.windowClose": DesktopWindowCloseConfig,
  "action.desktop.windowResize": DesktopWindowResizeConfig,
  "action.desktop.wait": DesktopWaitConfig,
  "action.desktop.paste": DesktopPasteConfig,
  "action.desktop.launchApp": DesktopLaunchAppConfig,
  // Actions: system (Wave 3 — integrated terminal)
  "action.system.terminal": SystemTerminalConfig,
  "action.terminal.session.open": TerminalSessionOpenConfig,
  "action.terminal.session.run": TerminalSessionRunConfig,
  "action.terminal.session.close": TerminalSessionCloseConfig,
  "action.terminal.script": TerminalScriptConfig,
  "action.terminal.readRecent": TerminalReadRecentConfig,
  "action.terminal.waitForExit": TerminalWaitForExitConfig,
  "trigger.terminal.command": TerminalCommandTriggerConfig,
  // Actions: local Git (ADR-0038)
  "action.git.stage": GitStageConfig,
  "action.git.commit": GitCommitConfig,
  "action.git.push": GitPushConfig,
  "action.git.branch": GitBranchConfig,
  // Data: OCR extraction (ADR-0024)
  "ocr.extract": OcrExtractConfig,
  // Eval nodes
  "eval.run": EvalRunConfig,
  "eval.gate": EvalGateConfig,
  // AI
  "ai.prompt": AiPromptConfig,
  "ai.classify": AiClassifyConfig,
  "ai.extract": AiExtractConfig,
  "ai.embed": AiEmbedConfig,
  "ai.ensemble": EnsembleConfig,
  // Flow
  "flow.branch": BranchConfig,
  "flow.switch": SwitchConfig,
  "flow.split": SplitConfig,
  "flow.join": JoinConfig,
  "flow.loop": LoopConfig,
  "flow.break": BreakConfig,
  "flow.continue": ContinueConfig,
  "flow.wait": WaitConfig,
  "flow.set": SetVariableConfig,
  "flow.subworkflow": SubworkflowConfig,
  "flow.catch": CatchConfig,
  // Data
  "data.transform": TransformConfig,
  "data.aggregate": AggregateConfig,
  "data.code": CodeConfig,
  "data.template": TemplateConfig,
  // I/O
  "io.http": HttpRequestConfig,
  "io.webhook.respond": WebhookRespondConfig,
  "io.output": OutputConfig,
  // Annotations
  "annotation.note": NoteConfig,
  "annotation.group": GroupAnnotationConfig,
  // GitHub Delivery
  "trigger.github.webhook": GithubWebhookTriggerConfig,
  "action.github.openPr": GithubOpenPrConfig,
  "action.github.closePr": GithubClosePrConfig,
  "action.github.mergePr": GithubMergePrConfig,
  "action.github.reviewPr": GithubReviewPrConfig,
  "action.github.reviewPrInline": GithubReviewPrInlineConfig,
  "action.github.commentPr": GithubCommentPrConfig,
  "action.github.commentIssue": GithubCommentIssueConfig,
  "action.github.labelIssue": GithubLabelIssueConfig,
  "action.github.closeIssue": GithubCloseIssueConfig,
  "action.github.createRelease": GithubCreateReleaseConfig,
  "action.github.generateChangelog": GithubGenerateChangelogConfig,
  "action.github.pushTag": GithubPushTagConfig,
  "action.github.runIssueLoop": GithubRunIssueLoopConfig,
}

/**
 * Resolve the config component for a given kind. Always returns a component —
 * unregistered kinds fall back to the generic JSON editor so users can always
 * tweak params at the JSON level.
 */
export function getNodeConfigComponent(kind: WorkflowNodeKind): NodeConfigComponent {
  return REGISTRY[kind] ?? GenericJsonConfig
}

/**
 * Entry-aware variant: prefers the built-in REGISTRY hit, then a JSON Schema
 * driven `SchemaForm` (for plugin entries that ship a `paramsSchema`), then
 * the raw-JSON fallback. This is what the inspector should call once it has
 * a `NodeCatalogEntry` in hand.
 */
export function getNodeConfigComponentForEntry(
  entry: Pick<NodeCatalogEntry, "kind" | "paramsSchema">
): NodeConfigComponent {
  const builtIn = REGISTRY[entry.kind]
  if (builtIn) return builtIn
  if (entry.paramsSchema) {
    const schema = entry.paramsSchema
    const SchemaFormForKind: NodeConfigComponent = ({ params, onChange }) => (
      <SchemaForm schema={schema} params={params} onChange={onChange} />
    )
    SchemaFormForKind.displayName = `SchemaFormFor(${entry.kind})`
    return SchemaFormForKind
  }
  return GenericJsonConfig
}

/** Whether a registered (non-fallback) component exists. */
export function hasDedicatedConfig(kind: WorkflowNodeKind): boolean {
  return REGISTRY[kind] !== undefined
}

/**
 * Whether the inspector has a structured form (built-in OR schema-driven)
 * for this entry. Used to suppress the "no dedicated config yet" hint when
 * a plugin author provides a `paramsSchema`.
 */
export function hasDedicatedConfigForEntry(
  entry: Pick<NodeCatalogEntry, "kind" | "paramsSchema">
): boolean {
  if (REGISTRY[entry.kind] !== undefined) return true
  return Boolean(entry.paramsSchema)
}
