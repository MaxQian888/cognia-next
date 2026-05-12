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
  GithubRunIssueLoopConfig,
  GithubWebhookTriggerConfig,
} from "./forms/github-forms"
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
  GenericJsonConfig,
  GroupAnnotationConfig,
  HttpRequestConfig,
  JoinConfig,
  LoopConfig,
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
  TeamCreateConfig,
  TeamRunConfig,
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
}>

const REGISTRY: Partial<Record<WorkflowNodeKind, NodeConfigComponent>> = {
  // Triggers
  "trigger.manual": ManualTriggerConfig,
  "trigger.cron": CronConfig,
  "trigger.connector.inbound": ConnectorInboundConfig,
  "trigger.chat.message": ChatMessageTriggerConfig,
  "trigger.webhook": WebhookTriggerConfig,
  // Actions: characters
  "action.character.send": CharacterSendConfig,
  "action.character.create": CharacterCreateConfig,
  "action.character.update": CharacterUpdateConfig,
  // Actions: teams
  "action.team.run": TeamRunConfig,
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
