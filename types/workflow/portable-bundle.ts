import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import type { VisualWorkflow, WorkflowInterface } from "./visual"

export interface WorkflowPortableDependency {
  kind: "plugin" | "model" | "tool" | "knowledge" | "secret"
  id: string
  required: true
  source: string
}

export interface WorkflowPortableBundle {
  apiVersion: "cognia.ai/workflow-bundle/v1"
  profile: "cognia-native"
  createdAt: number
  interface: WorkflowInterface
  workflows: VisualWorkflow[]
  templates: TemplateDefinitionEnvelope[]
  dependencies: WorkflowPortableDependency[]
  configSlots: Array<{
    key: string
    kind: "secretRef" | "model" | "tool" | "knowledge"
    required: boolean
  }>
  digest: string
}

export interface WorkflowPortableCompatibilityIssue {
  code:
    | "invalid_bundle"
    | "workflow_conflict"
    | "template_conflict"
    | "missing_plugin"
    | "missing_model"
    | "missing_tool"
    | "missing_knowledge"
    | "missing_secret_ref"
  path: string
  message: string
}

export interface WorkflowPortablePreflight {
  ok: boolean
  bundle?: WorkflowPortableBundle
  blockers: WorkflowPortableCompatibilityIssue[]
  warnings: WorkflowPortableCompatibilityIssue[]
}
