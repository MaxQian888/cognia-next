// Pi settings adapter (ADR-0119).
//
// Source file: `<pi agent dir>/settings.json`, i.e. `$PI_CODING_AGENT_DIR` or
// `~/.pi/agent`. Project overrides live in `<repo>/.pi/settings.json`.
//
// Two deliberate omissions:
//
//   - **`packages` is never imported here.** It is Pi's installed-extension
//     list, owned by the Pi package manager, not a preference. Surfacing 18
//     npm specs as "settings to import" would be actively misleading, and
//     applying them would install nothing (Pi resolves that array itself).
//   - **Only the keys below are read.** Pi keeps credentials in a separate
//     mode-600 `auth.json` / `models-store.json`, so `settings.json` is not a
//     credential file today — but a custom-provider block could carry one, so
//     this adapter reads an explicit allowlist rather than iterating whatever
//     it finds.

import { settingsDraft, type SettingsImportDraft, type SettingsSnapshot } from "../types"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Pi's thinking levels map onto Cognia's reasoning effort one-for-one. Pi also
 * accepts `none`, which Cognia expresses as `low` rather than dropping the
 * setting entirely.
 */
const THINKING_TO_EFFORT: Record<string, string> = {
  none: "low",
  low: "low",
  medium: "medium",
  high: "high",
}

/**
 * Keys Cognia knowingly cannot represent. Listing them (rather than ignoring
 * them) is what makes the preview honest: the user sees that Pi had an opinion
 * here and that Cognia is not going to carry it over.
 */
const UNSUPPORTED: Array<[key: string, group: "model" | "sandbox" | "env" | "ui", why: string]> = [
  ["compaction", "env", "Pi's compaction budget is managed by Pi's own context loop."],
  ["retry", "env", "Pi's provider retry policy has no Cognia equivalent."],
  ["steeringMode", "env", "Steering queue behaviour is owned by the Pi runtime."],
  ["followUpMode", "env", "Follow-up queue behaviour is owned by the Pi runtime."],
  ["defaultProjectTrust", "sandbox", "Pi project trust is not a Cognia sandbox setting."],
  ["externalEditor", "ui", "Pi's external editor command is Pi-only."],
  ["theme", "ui", "Pi themes are not Cognia themes."],
  ["markdown", "ui", "Pi's markdown rendering options are Pi-only."],
  ["images", "ui", "Pi's image auto-resize is applied before Pi sends the request."],
  ["enableAnalytics", "ui", "Telemetry is configured separately in Cognia."],
  ["enableInstallTelemetry", "ui", "Telemetry is configured separately in Cognia."],
  ["showCacheMissNotices", "ui", "Pi prompt-cache notices are a Pi TUI affordance."],
  ["collapseChangelog", "ui", "Pi changelog display is a Pi TUI affordance."],
  ["enabledModels", "model", "Pi's model shortlist is scoped to Pi's own provider catalog."],
]

export function settingsFromPi(current: SettingsSnapshot, input: unknown): SettingsImportDraft[] {
  const source = record(input)
  const drafts: SettingsImportDraft[] = []

  // Pi stores provider and model separately; Cognia's defaultModel is one
  // string, so recombine them the same way `parsePiModel` splits them.
  const provider = typeof source.defaultProvider === "string" ? source.defaultProvider : undefined
  const model = typeof source.defaultModel === "string" ? source.defaultModel : undefined
  if (model) {
    drafts.push(
      settingsDraft(
        "pi",
        "model",
        "defaultModel",
        "defaultModel",
        current.defaultModel,
        provider ? `${provider}/${model}` : model,
        {
          warnings: provider
            ? []
            : ["No defaultProvider in Pi's settings — the model id is imported unqualified."],
        }
      )
    )
  }

  const thinking =
    typeof source.defaultThinkingLevel === "string"
      ? source.defaultThinkingLevel.toLowerCase()
      : undefined
  if (thinking) {
    const effort = THINKING_TO_EFFORT[thinking]
    drafts.push(
      settingsDraft(
        "pi",
        "model",
        "defaultThinkingLevel",
        effort ? "defaultEffort" : "unsupported",
        current.defaultEffort,
        effort ?? source.defaultThinkingLevel,
        effort
          ? {}
          : {
              supported: false,
              warnings: [`Unknown Pi thinking level "${source.defaultThinkingLevel}".`],
            }
      )
    )
  }

  for (const [key, group, why] of UNSUPPORTED) {
    if (source[key] === undefined) continue
    drafts.push(
      settingsDraft("pi", group, key, "unsupported", undefined, source[key], {
        supported: false,
        warnings: [why],
      })
    )
  }

  return drafts
}
