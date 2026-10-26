/**
 * The plugin contract's share of `lib/project-environment/image-reference.ts`, which re-exports these.
 */
export interface ImageReference {
  registry: string
  repository: string
  tag?: string
  /** Lowercased `sha256:<hex>`. */
  digest?: string
}
