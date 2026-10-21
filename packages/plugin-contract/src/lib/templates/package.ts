/**
 * The plugin contract's share of `lib/templates/package.ts`, which re-exports these.
 */
import type { PackageFileRecord, PackageSignature } from "../packaging/signed-zip"
import type { TEMPLATE_API_VERSION } from "@/lib/templates/contracts"
import type { TEMPLATE_PACKAGE_SCHEMA_VERSION } from "@/lib/templates/package-manifest"
import type { TemplatePlatform } from "./contracts"

export type TemplatePackageFileRecord = PackageFileRecord

export interface TemplatePackageDefinitionRecord extends TemplatePackageFileRecord {
  id: string
  version: string
}

export type TemplatePackageSignature = PackageSignature

export interface TemplatePackageManifest {
  schemaVersion: typeof TEMPLATE_PACKAGE_SCHEMA_VERSION
  apiVersion: typeof TEMPLATE_API_VERSION
  id: string
  version: string
  name: string
  description?: string
  entrypoints: string[]
  definitions: TemplatePackageDefinitionRecord[]
  assets: TemplatePackageFileRecord[]
  compatibility?: {
    platforms?: TemplatePlatform[]
    minHostVersion?: string
    maxHostVersion?: string
  }
  signature?: TemplatePackageSignature
}
