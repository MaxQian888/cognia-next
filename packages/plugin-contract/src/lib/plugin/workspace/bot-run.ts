/**
 * The plugin contract's share of `lib/plugin/workspace/bot-run.ts`, which re-exports these.
 */
export interface BotRunWorkspaceSpec {
  kind: "bot-run"
  runId: string
  repository: string
  ref: string
  /** Moving branch whose SHA must still match the acquired commit before publishing. */
  targetRef?: string
  credentialSlot: string
}

export interface BotWorkspaceFile {
  path: string
  oldContent: string | null
  newContent: string | null
  status: "added" | "modified" | "deleted"
  mode: "100644" | "100755"
}

export interface BotWorkspaceSnapshot {
  id: string
  runId: string
  baseSha: string
  headSha: string
  diff: string
  files: BotWorkspaceFile[]
  capturedAt: number
}

export interface BotWorkspacePublishInput {
  approvalId: string
  snapshotId: string
  message: string
  branch: string
}
