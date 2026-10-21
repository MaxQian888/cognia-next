/**
 * The plugin contract's share of `lib/templates/contracts.ts`, which re-exports these.
 */
import type {
  TEMPLATE_API_VERSION,
  TEMPLATE_CATALOG_ONLY_DOMAINS,
  TEMPLATE_FULL_DOMAINS,
} from "@/lib/templates/contracts"

export type TemplateDomain =
  (typeof TEMPLATE_FULL_DOMAINS)[number] | (typeof TEMPLATE_CATALOG_ONLY_DOMAINS)[number]

export type TemplatePlatform = "desktop" | "web" | "mobile"

export type TemplateStatus =
  "draft" | "conflict" | "published" | "deprecated" | "yanked" | "tombstone"

export type TemplateTrust = "built-in" | "verified-publisher" | "signed-unknown" | "unsigned"

export type TemplateJson =
  null | boolean | number | string | TemplateJson[] | { [key: string]: TemplateJson }

export interface TemplateMetadata {
  name: string
  description?: string
  localized?: Record<string, { name: string; description?: string }>
  tags?: string[]
  category?: string
  author?: string
  icon?: string
}

export interface TemplateInputBase {
  id: string
  label: string
  description?: string
  required: boolean
}

export type TemplateInputSpec =
  | (TemplateInputBase & {
      kind: "string" | "number" | "boolean"
      defaultValue?: string | number | boolean
    })
  | (TemplateInputBase & {
      kind: "enum"
      options: string[]
      defaultValue?: string
    })
  | (TemplateInputBase & {
      kind:
        | "resource"
        | "secretRef"
        | "twinSlot"
        | "model"
        | "provider"
        | "tool"
        | "skill"
        | "character"
        | "workflow"
      resourceKind?: string
      selector?: {
        allowMultiple?: boolean
        capability?: string
        localOnly?: boolean
      }
    })

export interface TemplateDependency {
  id: string
  kind: "template" | "plugin" | "skill" | "tool" | "model" | "provider" | "connector"
  requirement: "required" | "optional"
  version?: string
  fallback?: "omit" | "default"
  defaultValue?: TemplateJson
}

export interface TemplateCompatibility {
  platforms: TemplatePlatform[]
  minHostVersion?: string
  maxHostVersion?: string
}

export interface TemplateProvenance {
  source: "built-in" | "user" | "plugin" | "marketplace" | "file" | "link" | "legacy"
  packageId?: string
  pluginId?: string
  publisher?: string
  sourceUrl?: string
  trust?: TemplateTrust
  signatureFingerprint?: string
}

export interface TemplateDefinitionEnvelope<TPayload extends TemplateJson = TemplateJson> {
  apiVersion: typeof TEMPLATE_API_VERSION
  id: string
  domain: TemplateDomain
  status: TemplateStatus
  revision: number
  version: string | null
  metadata: TemplateMetadata
  payload: TPayload
  inputs: TemplateInputSpec[]
  dependencies: TemplateDependency[]
  capabilities: string[]
  compatibility: TemplateCompatibility
  provenance: TemplateProvenance
  contentHash: string
  baselineHash?: string
  createdAt: number
  updatedAt: number
}

export type TemplateDefinitionDraft<TPayload extends TemplateJson = TemplateJson> = Omit<
  TemplateDefinitionEnvelope<TPayload>,
  "apiVersion" | "contentHash" | "version" | "createdAt" | "updatedAt"
> & {
  apiVersion?: typeof TEMPLATE_API_VERSION
  contentHash?: string
  version?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface TemplateValidationIssue {
  code: string
  path: string
  message: string
  severity: "error" | "warning"
}

export interface TemplateValidationResult {
  ok: boolean
  issues: TemplateValidationIssue[]
}

export type TemplateVersionBump = "patch" | "minor" | "major"
