// Storybook-only fixture builders for the agent-area settings panels
// (`components/settings/{agent,agent-runtime,subagents,goals,lsp,terminal}/**`).
// These panels read the global `useSettingsStore` and fall back to library
// defaults when `settings` is null, so stories seed a realistic
// `AppSettings`-shaped blob covering only the fields the panel actually reads.
//
// The full `AppSettings` type is large; we build the subset the agent UIs touch
// and cast through `unknown`, mirroring the established pattern in
// `lib/storybook/fixtures/settings-search.ts` and the stt-card story.
import type { AppSettings } from "@/lib/claude/types"

/**
 * Build an `AppSettings`-shaped object from a shallow patch. Pass only the
 * fields the panel under test reads (e.g. `agentPermissions`, `terminal`,
 * `lsp`, `goals`). Everything else stays undefined so the panel exercises its
 * library-default fallbacks.
 */
export function makeAgentAppSettings(patch: Record<string, unknown> = {}): AppSettings {
  return { ...patch } as unknown as AppSettings
}

/** A populated command-/tool-permission config for the agent-runtime cards. */
export function makeConfiguredPermissions(): AppSettings {
  return makeAgentAppSettings({
    agentPermissions: {
      autoApprove: { enabled: true, mode: "rules+model", denyOnHighRisk: true },
      commandRules: {
        "git status": "allow",
        "rm -rf *": "deny",
        "npm run *": "ask",
      },
      toolRules: {
        Bash: { "git *": "allow" },
        "*": { "**/*.env": "deny" },
      },
    },
    toolSearchRuntime: {
      enabled: true,
      alwaysLoadServers: ["cognia-tools"],
      alwaysLoadTools: ["mcp__cognia-tools__file_hash"],
    },
  })
}

/** A populated agent-runtime "Defaults" tab config. */
export function makeConfiguredDefaults(): AppSettings {
  return makeAgentAppSettings({
    permissionMode: "acceptEdits",
    defaultModel: "claude-sonnet-4-5",
    defaultProvider: "anthropic",
    defaultWorkingDir: "/home/dev/project",
    defaultSystemPrompt: "Always prefer the smallest change that solves the task.",
    defaultMaxThinkingTokens: 8192,
    routingFallbackEnabled: true,
    outputStyle: "default",
    briefMode: true,
  })
}
