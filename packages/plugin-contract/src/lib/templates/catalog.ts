/**
 * The plugin contract's share of `lib/templates/catalog.ts`, which re-exports these.
 */
import type {
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplatePlatform,
  TemplateStatus,
  TemplateTrust,
} from "./contracts"

export interface TemplateCatalogQuery {
  domain?: TemplateDomain
  status?: TemplateStatus
  source?: TemplateDefinitionEnvelope["provenance"]["source"]
  trust?: TemplateTrust
  platform?: TemplatePlatform
  text?: string
}
