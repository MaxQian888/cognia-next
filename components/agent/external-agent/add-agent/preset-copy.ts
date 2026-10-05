/**
 * The translated copy for a preset, where the catalogue carries its own.
 *
 * Preset definitions ship English prose (they are also read by plugins and the
 * CLI). For the presets whose setup is non-obvious the app catalogue has a
 * translated version, and every surface that shows a preset — the desktop
 * dialog, the settings gallery, the phone's flow — must pick the same one.
 * Before this lived in one place, each of them repeated the same ladder of
 * conditionals, and a preset added to one ladder was missing from the others.
 */

import type { ExternalAgentPresetConfig } from "@/lib/ai/agent/external/config/presets"
import type { ExternalAgentEcosystemSupportTier } from "@/types/agent/external-agent"

/** `useTranslations("externalAgent.manager")` / `("externalAgent.settings")`. */
type Translate = (key: string) => string

const SETUP_HINT_KEYS: Readonly<Record<string, string>> = {
  devin: "devinSetupHint",
  aider: "aiderSetupHint",
  qoder: "qoderSetupHint",
  kimi: "kimiSetupHint",
  cline: "clineSetupHint",
  goose: "gooseSetupHint",
}

const ENV_VAR_HINT_KEYS: Readonly<Record<string, string>> = {
  aider: "aiderEnvVarHint",
  qoder: "qoderEnvVarHint",
  kimi: "kimiEnvVarHint",
  cline: "clineEnvVarHint",
  goose: "gooseEnvVarHint",
}

const DESCRIPTION_KEYS: Readonly<Record<string, string>> = {
  "opencode-v2-service": "opencodeV2PresetDescription",
  devin: "devinPresetDescription",
  aider: "aiderPresetDescription",
  qoder: "qoderPresetDescription",
  kimi: "kimiPresetDescription",
  cline: "clinePresetDescription",
  goose: "goosePresetDescription",
}

const NAME_KEYS: Readonly<Record<string, string>> = {
  "opencode-v2-service": "opencodeV2PresetName",
}

/**
 * Setup hints whose translation lives under `externalAgent.settings` rather
 * than `externalAgent.manager`: the presets only the settings editor offers.
 */
const SETTINGS_SETUP_HINT_KEYS: Readonly<Record<string, string>> = {
  "opencode-v2-service": "opencodeV2PresetSetupHint",
}

/**
 * The label (under `externalAgent.settings`) of the dedicated, masked
 * environment editor a preset's sign-in needs, keyed by preset id.
 */
const ENVIRONMENT_LABEL_KEYS: Readonly<Record<string, string>> = {
  aider: "aiderEnvironment",
  qoder: "qoderEnvironment",
  kimi: "kimiEnvironment",
  cline: "clineEnvironment",
}

/**
 * Setup hint. `tManager` is `externalAgent.manager`; `tSettings`
 * (`externalAgent.settings`) is needed only by a surface that offers the
 * settings-only presets, which otherwise fall back to the preset's prose.
 */
export function presetSetupHint(
  tManager: Translate,
  presetId: string,
  preset: ExternalAgentPresetConfig,
  tSettings?: Translate
): string | undefined {
  if (!preset.setupHint) return undefined
  const settingsKey = SETTINGS_SETUP_HINT_KEYS[presetId]
  if (settingsKey && tSettings) return tSettings(settingsKey)
  const key = SETUP_HINT_KEYS[presetId]
  return key ? tManager(key) : preset.setupHint
}

/**
 * The label of the environment editor that carries a runtime's own sign-in
 * (a PAT, an API key, a config root), or `undefined` when the generic
 * "process environment" editor is the right one. Aider is recognised by its
 * protocol too: a hand-configured `aider-cli` agent needs the same provider
 * keys as the preset. `tSettings` is `externalAgent.settings`.
 */
export function presetEnvironmentLabel(
  tSettings: Translate,
  presetId: string | undefined,
  protocol: string
): string | undefined {
  const key =
    (presetId ? ENVIRONMENT_LABEL_KEYS[presetId] : undefined) ??
    (protocol === "aider-cli" ? ENVIRONMENT_LABEL_KEYS.aider : undefined)
  return key ? tSettings(key) : undefined
}

/** Environment-variable note. `tManager` is `externalAgent.manager`. */
export function presetEnvVarHint(
  tManager: Translate,
  presetId: string,
  preset: ExternalAgentPresetConfig
): string | undefined {
  if (!preset.envVarHint) return undefined
  const key = ENV_VAR_HINT_KEYS[presetId]
  return key ? tManager(key) : preset.envVarHint
}

/** One-paragraph description. `tSettings` is `externalAgent.settings`. */
export function presetDescription(
  tSettings: Translate,
  presetId: string,
  preset: ExternalAgentPresetConfig
): string {
  const key = DESCRIPTION_KEYS[presetId]
  return key ? tSettings(key) : preset.description
}

/** Display name. `tSettings` is `externalAgent.settings`. */
export function presetName(
  tSettings: Translate,
  presetId: string,
  preset: ExternalAgentPresetConfig
): string {
  const key = NAME_KEYS[presetId]
  return key ? tSettings(key) : preset.name
}

/**
 * Label key (under `externalAgent.supportTier`) for a support tier. The tier
 * ids are wire vocabulary; showing them raw put "executable" in English on
 * every screen, whatever the locale.
 */
export const SUPPORT_TIER_LABEL_KEYS: Readonly<Record<ExternalAgentEcosystemSupportTier, string>> =
  {
    executable: "executable",
    guided: "guided",
    "documented-only": "documentedOnly",
  }

/** `useTranslations("externalAgent.supportTier")`. */
export function supportTierLabel(t: Translate, tier: ExternalAgentEcosystemSupportTier): string {
  return t(SUPPORT_TIER_LABEL_KEYS[tier])
}
