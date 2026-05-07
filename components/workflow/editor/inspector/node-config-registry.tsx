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
import {
  AiPromptConfig,
  BranchConfig,
  CharacterSendConfig,
  ChatMessageTriggerConfig,
  CodeConfig,
  ConnectorInboundConfig,
  ConnectorSendConfig,
  CronConfig,
  GenericJsonConfig,
  HttpRequestConfig,
  ManualTriggerConfig,
  NoteConfig,
  SetVariableConfig,
  SkillInvokeConfig,
  TeamRunConfig,
  TemplateConfig,
  TransformConfig,
  TwinRagConfig,
  WaitConfig,
} from "./forms"

export type NodeConfigComponent = ComponentType<{
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}>

const REGISTRY: Partial<Record<WorkflowNodeKind, NodeConfigComponent>> = {
  "trigger.manual": ManualTriggerConfig,
  "trigger.cron": CronConfig,
  "trigger.connector.inbound": ConnectorInboundConfig,
  "trigger.chat.message": ChatMessageTriggerConfig,
  "action.character.send": CharacterSendConfig,
  "action.team.run": TeamRunConfig,
  "action.skill.invoke": SkillInvokeConfig,
  "action.twin.rag": TwinRagConfig,
  "action.connector.send": ConnectorSendConfig,
  "ai.prompt": AiPromptConfig,
  "flow.branch": BranchConfig,
  "flow.set": SetVariableConfig,
  "flow.wait": WaitConfig,
  "io.http": HttpRequestConfig,
  "data.code": CodeConfig,
  "data.template": TemplateConfig,
  "data.transform": TransformConfig,
  "annotation.note": NoteConfig,
}

/**
 * Resolve the config component for a given kind. Always returns a component —
 * unregistered kinds fall back to the generic JSON editor so users can always
 * tweak params at the JSON level.
 */
export function getNodeConfigComponent(kind: WorkflowNodeKind): NodeConfigComponent {
  return REGISTRY[kind] ?? GenericJsonConfig
}

/** Whether a registered (non-fallback) component exists. */
export function hasDedicatedConfig(kind: WorkflowNodeKind): boolean {
  return REGISTRY[kind] !== undefined
}
