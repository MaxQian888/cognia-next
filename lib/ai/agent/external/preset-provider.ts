import type { ProviderId } from "@/types/subscription"

/**
 * Map an external-agent preset to the subscription provider whose accounts back
 * it, or `null` for presets that carry no subscription credential (gemini-cli,
 * cursor-cli, custom, …).
 *
 * Shared by the pre-spawn env resolver (`env-builder.ts`, which resolves the
 * bound account's env) and the settings account picker (which lists that
 * provider's accounts) so the two never disagree about which provider a preset
 * authenticates against.
 */
export function providerIdForPreset(preset: string | null | undefined): ProviderId | null {
  switch (preset) {
    case "codex":
    case "codex-app-server":
      return "codex"
    case "claude-code":
      return "anthropic"
    case "opencode-server":
    case "opencode-remote":
      return "opencode"
    default:
      return null
  }
}
