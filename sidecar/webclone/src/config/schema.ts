export type SnapshotMode = "single" | "bundle"
export type FrameworkHint = "vue" | "react" | "svelte"
export type CodegenFramework = "vue" | "react" | "angular" | "svelte" | "jquery"

export interface FrameworkCodeGenOptions {
  framework?: CodegenFramework
  typescript?: boolean
  cssModules?: boolean
  generateDrafts?: boolean
  extractSharedLogic?: boolean
}

/**
 * Unified config for all operations:
 * - Snapshot (fetch + bundle/single)
 * - Component extraction
 * - Framework code generation
 * - Local conversion
 */
export interface SnapshotOptions {
  url: string
  output: string
  mode: SnapshotMode
  maxAssets: number
  concurrency: number
  timeout: number
  retryCount: number
  retryInitialDelay?: number
  retryMaxDelay?: number
  inline: boolean
  pretty: boolean
  extractComponents?: boolean
  componentDepth?: number
  frameworkHint?: FrameworkHint
  extractLogic?: boolean
  frameworkCodegen?: FrameworkCodeGenOptions
  skipExtensions?: string[]
  maxFileSize?: number
  memoryLimit?: number
  convertLocal?: string
  /**
   * When true, the SSRF guard permits private/loopback/link-local targets.
   * Defaults to false (deny). Mirrors the app-side `allowPrivateHosts` opt-in.
   */
  allowPrivateHosts?: boolean
}

/**
 * Memory budget & degradation strategy.
 * Three layers: quick preview → runtime monitoring → pipeline downgrade.
 */
export type HtmlStrategy = "full" | "streaming" | "skip"
export type CssStrategy = "full" | "head" | "skip"
export type JsStrategy = "full" | "head" | "skip"

export interface MemoryBudget {
  htmlParseBudget: number
  cssParseBudget: number
  jsParseBudget: number
  htmlStrategy: HtmlStrategy
  cssStrategy: CssStrategy
  jsStrategy: JsStrategy
}
