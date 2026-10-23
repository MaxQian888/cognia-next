/**
 * The plugin contract's share of `lib/project-environment/environment-declaration.ts`, which re-exports these.
 */
import type {
  DeclarationFile,
  DeclaredUser,
  ForwardPort,
  LifecycleCommands,
} from "../../types/sandbox/environment-spec"
import type { ImageReference } from "./image-reference"

export interface EnvironmentDeclaration {
  file: DeclarationFile
  /** Repository-relative path of the declaring file. */
  path: string
  image?: ImageReference
  /** Validated devcontainer build inputs, included in the approval digest. */
  build?: Record<string, unknown>
  /**
   * Values may contain `${containerEnv:NAME}` or `${containerEnv:NAME:default}`,
   * expanded by `cognia-sandboxd` against the image's environment when a
   * process starts (ADR-0183). Every other variable form is refused at parse.
   */
  containerEnv: Record<string, string>
  remoteEnv?: Record<string, string | null>
  workspaceFolder?: string
  lifecycleTimeoutMs?: number
  lifecycleCommands: LifecycleCommands
  forwardPorts: ForwardPort[]
  user?: DeclaredUser
  /** Lowercased, unique, sorted. Only `.cognia/workspace.json` can request these. */
  egressDomains: string[]
}

/**
 * The `environment` block of `.cognia/workspace.json`. Either it points at a
 * devcontainer (and may add egress domains, which devcontainer.json cannot
 * express), or it declares the environment inline in the devcontainer shapes.
 */
export type WorkspaceEnvironmentBlock =
  | { kind: "devcontainer"; path: string; egressDomains: string[] }
  | { kind: "inline"; declaration: EnvironmentDeclaration }
