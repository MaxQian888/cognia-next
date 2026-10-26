/**
 * The plugin contract's share of `lib/task-workspace/types.ts`, which re-exports these.
 */
export type WorkspaceBaseSpec =
  | { kind: "workingState" }
  | { kind: "localHead" }
  | { kind: "remoteDefault" }
  | { kind: "gitRef"; gitRef: string }
  | {
      kind: "pullRequest"
      provider: string
      repo: string
      number: number
      fetchRef?: string
      headSha?: string
    }
