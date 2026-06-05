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
  AiClassifyConfig,
  AiEmbedConfig,
  AiExtractConfig,
  AiPromptConfig,
  BranchConfig,
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
  GoalCompletedTriggerConfig,
  GroupAnnotationConfig,
  HttpRequestConfig,
  JoinConfig,
  LoopConfig,
  BreakConfig,
  ContinueConfig,
  ManualTriggerConfig,
  McpInvokeToolConfig,
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
  TwinIngestConfig,
  TwinRagConfig,
  WaitConfig,
  WebhookRespondConfig,
  WebhookTriggerConfig,
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
  // Data
  "data.transform": TransformConfig,
  "data.code": CodeConfig,
  "data.template": TemplateConfig,
  // I/O
  "io.http": HttpRequestConfig,
  "io.webhook.respond": WebhookRespondConfig,
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
