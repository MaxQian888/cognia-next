/**
 * The plugin contract's share of `lib/plugin/workspace/acquire.ts`, which re-exports these.
 */
/** How the caller named the repository. */
export type WorkspaceAcquireSpec =
  | import("./bot-run").BotRunWorkspaceSpec
  | { kind: "current-project" }
  | { kind: "local-path"; path: string }
  | {
      kind: "git-url"
      url: string
      ref?: string
      /** Compatibility hint only; every entry must already be manifest-authorized. */
      allowedHosts?: string[]
    }
  /** Whatever the user typed — resolved by {@link parseRepoSpec}. */
  | { kind: "auto"; input: string; allowedHosts?: string[] }

export interface PluginWorkspaceHandle {
  /** Absolute filesystem root of the checkout. */
  root: string
  origin: "current-project" | "local-path" | "clone" | "bot-run"
  /** Host-issued ownership identity for isolated Bot workspaces. */
  id?: string
  runId?: string
  /** Host-owned runtime state outside the repository, for isolated Bot sessions. */
  runtimeStateRoot?: string
  /** Set when the checkout came from a remote. */
  remote?: { host: string; owner: string; repo: string; url: string; ref?: string }
  /** True when the checkout is ours to delete. */
  ephemeral: boolean
  /**
   * Commit the checkout was at when it was acquired. Absent when the path is
   * not a git repository, or when this runtime has no git bridge.
   *
   * The point of recording it here is that `changedSince` becomes answerable:
   * a caller that stored the ref knows a later empty diff means "nothing
   * changed", not "I asked about a ref the host could not resolve". Without
   * it those two answers are the same empty array.
   */
  headRef?: string
}
