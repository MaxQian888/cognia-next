import type { ChatSession } from "@cognia/agent-config-types"

/** Configuration only: provider history and conversation identity stay local. */
export function inheritableSessionConfig(
  parent: ChatSession,
  purpose: "branch" | "aside" = "branch"
): Partial<ChatSession> {
  const config: Partial<ChatSession> = {
    characterId: parent.characterId,
    teamId: parent.teamId,
    // Inherited alongside the other two identity columns: a branch continues
    // the same conversation, so it continues to run on the same executor.
    squadId: parent.squadId,
    disabledSkillIds: parent.disabledSkillIds,
    messageDisplayOverride: parent.messageDisplayOverride,
    model: parent.model,
    providerOverride: parent.providerOverride,
    accountId: parent.accountId,
    // Which models each external agent runs on is configuration, so a branch
    // keeps it. The gateway task links (`externalAgentSession`,
    // `externalAgentGatewaySessions`) are NOT copied: a task's native history
    // belongs to one conversation, and two rows resuming it would interleave
    // two threads in one memory, and deleting either would delete the other's.
    externalAgentModels: parent.externalAgentModels,
    sandboxEnabled: parent.sandboxEnabled,
    computerUseTarget: parent.computerUseTarget,
    // The third sandbox column, and the one that kept being missed. Without it
    // a branch re-resolves its tier from whatever `AppSettings.sandboxTier` says
    // *now* (`lib/sandbox/binding.ts`), so a child of a `microvm` conversation
    // can silently run on `os`. Isolation must never decrease unannounced.
    sandboxTier: parent.sandboxTier,
    // And the release that goes with it: a child of a conversation told to
    // follow the default must not be pinned on its first send.
    sandboxTierFollowsDefault: parent.sandboxTierFollowsDefault,
    systemPrompt: parent.systemPrompt,
    activePresetId: parent.activePresetId,
    workingDir: parent.workingDir,
    permissionMode: parent.permissionMode,
    bareMode: parent.bareMode,
    debugMode: parent.debugMode,
    briefMode: parent.briefMode,
    outputStyle: parent.outputStyle,
    customOutputStyle: parent.customOutputStyle,
    maxThinkingTokens: parent.maxThinkingTokens,
    toolFilter: parent.toolFilter,
  }
  // A side question uses one executor, never the parent's whole team or squad.
  // Ordinary branches still inherit both executor identities unchanged.
  if (purpose === "aside") {
    delete config.teamId
    delete config.squadId
  }
  return config
}

/** Fill legacy aside gaps without replacing explicit per-aside choices. */
export function missingInheritedSessionConfig(
  existing: ChatSession,
  parent: ChatSession
): Partial<ChatSession> {
  return Object.fromEntries(
    Object.entries(inheritableSessionConfig(parent, "aside")).filter(
      ([key, value]) => value !== undefined && existing[key as keyof ChatSession] === undefined
    )
  ) as Partial<ChatSession>
}
