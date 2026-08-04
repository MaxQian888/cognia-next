import type { ClaudeAgentSdkOptionsV1 } from "@cognia/agent-config-types/claude-agent-sdk-options"

export interface ClaudeSdkRolloutFlags {
  claudeSdkParityV1?: boolean
  claudeSdkSessionStore?: boolean
  claudeSdkCheckpoint?: boolean
  claudeSdkPrewarm?: boolean
}

/** Convert release flags into the only versioned block the sidecar consumes. */
export function claudeSdkRolloutOptions(
  flags: ClaudeSdkRolloutFlags
): ClaudeAgentSdkOptionsV1 | undefined {
  if (!flags.claudeSdkParityV1) return undefined
  if (flags.claudeSdkSessionStore && flags.claudeSdkCheckpoint) {
    throw new Error("Claude SDK session storage and file checkpointing are mutually exclusive")
  }
  return {
    version: 1,
    ...(flags.claudeSdkSessionStore
      ? { persistSession: true, sessionStore: { backend: "host-sqlite" as const } }
      : {}),
    ...(flags.claudeSdkCheckpoint ? { enableFileCheckpointing: true } : {}),
    ...(flags.claudeSdkPrewarm ? { prewarm: { enabled: true } } : {}),
  }
}
