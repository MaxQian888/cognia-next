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

/** Build the same tenant/workspace scope used by SDK turns for management calls. */
export async function sdkSessionApiOptions(input: {
  cwd?: string
  storage: "filesystem" | "host-sqlite"
  sessionId?: string
  surface?: "chat" | "cli"
  environment?: import("@/lib/ai/agent/execution/resolve-agent-execution-spec").AgentExecutionResolveInput["environment"]
}): Promise<import("./ipc").SdkSessionApiOptions> {
  const [
    { getAgentExecutionFlags },
    { resolveAgentExecutionEnvironment },
    { resolveAgentExecutionSpec, sendSpecFromResolved },
  ] = await Promise.all([
    import("@/lib/ai/agent/execution/feature-flags"),
    import("@/lib/ai/agent/execution/host-environment"),
    import("@/lib/ai/agent/execution/resolve-agent-execution-spec"),
  ])
  const { spec } = resolveAgentExecutionSpec({
    surface: input.surface ?? "chat",
    environment: input.environment ?? resolveAgentExecutionEnvironment(),
    flags: getAgentExecutionFlags(),
    policy: { executionKind: "agent", runtimePolicy: "claude-agent-sdk" },
    legacy: { providerId: "anthropic" },
    identity: input.sessionId ? { sessionId: input.sessionId } : undefined,
  })
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    execution: sendSpecFromResolved(spec),
    claudeAgentSdk:
      input.storage === "host-sqlite"
        ? { version: 1, persistSession: true, sessionStore: { backend: "host-sqlite" } }
        : { version: 1 },
  }
}

export type SdkSessionStorage = NonNullable<
  import("@cognia/agent-config-types").ChatSession["sdkSessionStorage"]
>

export function sdkSessionStorageFromOptions(
  options: import("@cognia/agent-config-types").SendOptions
): SdkSessionStorage {
  const store = options.claudeAgentSdk?.sessionStore
  return store
    ? {
        backend: "host-sqlite",
        workspace: store.workspace !== undefined ? store.workspace : (options.cwd ?? null),
      }
    : { backend: "filesystem" }
}

export function sdkOptionsForStorage(
  storage: SdkSessionStorage,
  current?: ClaudeAgentSdkOptionsV1
): ClaudeAgentSdkOptionsV1 {
  const next: ClaudeAgentSdkOptionsV1 = { ...current, version: 1 }
  if (storage.backend === "host-sqlite") {
    next.persistSession = true
    next.sessionStore = {
      ...next.sessionStore,
      backend: "host-sqlite",
      workspace: storage.workspace ?? null,
    }
    delete next.enableFileCheckpointing
  } else {
    delete next.sessionStore
  }
  return next
}
