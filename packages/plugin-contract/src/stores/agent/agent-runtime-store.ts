/**
 * The plugin contract's share of `stores/agent/agent-runtime-store.ts`, which re-exports these.
 */
/**
 * @deprecated Compatibility mirror of {@link AgentRuntimeState.runtimeRef}.
 * The lane is now an `AgentRuntimeRef`, which also names the target, so a
 * "which agent" answer can no longer go missing from a "which lane" answer.
 * Readers still on this field are being migrated.
 */
export type AgentRuntime = "claude-sdk" | "external"
