"use client"

/**
 * Trust and dependency-warning chips for Character Packs (ADR-0030).
 *
 * Two separate signals that are easy to conflate:
 *
 *   * **Trust** — did this pack's Ed25519 signature verify? Only ever
 *     `verified` or `unsigned`; a signed pack whose signature does not verify
 *     never reaches the registry, so there is deliberately no "invalid" chip to
 *     render. See `lib/plugin/character-pack/pack-trust.ts`.
 *   * **Warnings** — does this pack reference a skill / preset / theme pack /
 *     connector / provider that is not installed? Never blocking; the pack
 *     registers and its characters resolve either way (ADR-0030 §B.6).
 *
 * A pack can be verified and still carry warnings: the signature attests to
 * *who wrote it*, not to *what is installed on this machine*.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { CharacterPackTrust } from "@/lib/plugin/character-pack/pack-trust"
import type { PluginCharacterPackWarning } from "@/lib/plugin/character-pack/validate-requires"

/**
 * Warning code → i18n key, under the `settings.characters.warning` namespace.
 *
 * Exhaustive by construction: `Record<Code, string>` makes adding a member to
 * the `code` union a **compile error** here until it is given a message. The
 * i18n lint cannot provide that guarantee, because it cannot see through a
 * template-literal `t()` call — which is exactly how the previous
 * `${w.code}: ${w.missingId}` tooltips shipped untranslated.
 */
export const PACK_WARNING_MESSAGE_KEY: Record<PluginCharacterPackWarning["code"], string> = {
  "missing-skill": "missingSkill",
  "missing-plugin-skill": "missingPluginSkill",
  "missing-mcp-preset": "missingMcpPreset",
  "missing-native-tool": "missingNativeTool",
  "missing-a2ui-catalog": "missingA2uiCatalog",
  "missing-theme-pack": "missingThemePack",
  "missing-connector": "missingConnector",
  "missing-provider": "missingProvider",
}

/** Minimal shape of a `next-intl` translator, so callers can inject a fake. */
type Translate = (key: string, values?: Record<string, string | number>) => string

/**
 * Render the warning list as tooltip text — one localized line per warning.
 *
 * Exported so the pack row and the character row produce identical text; they
 * previously drifted, each hand-rolling its own template literal.
 */
export function formatPackWarnings(
  warnings: readonly PluginCharacterPackWarning[],
  t: Translate
): string {
  return warnings
    .map((warning) => {
      const message = t(`warning.${PACK_WARNING_MESSAGE_KEY[warning.code]}`, {
        id: warning.missingId,
      })
      return warning.characterLocalId
        ? t("warning.characterScope", { message, localId: warning.characterLocalId })
        : message
    })
    .join("\n")
}

export interface PackTrustChipProps {
  trust: CharacterPackTrust
  /**
   * Plugin-contributed packs pass `false`. Their authenticity is already
   * anchored by the plugin's own install receipt (`PluginVerificationReceipt`),
   * so an "Unsigned" chip beside them would claim a gap that does not exist —
   * actively misleading rather than merely noisy. Local `.cognia-pack.json`
   * files, which arrive from anywhere, pass `true`.
   */
  showUnsigned: boolean
}

/**
 * The trust chip. Renders nothing when a pack is unsigned and unsigned is not
 * worth reporting — see {@link PackTrustChipProps.showUnsigned}.
 */
export function PackTrustChip({ trust, showUnsigned }: PackTrustChipProps) {
  const t = useTranslations("settings.characters")

  if (trust.state === "verified") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
        title={t("trust.verifiedTooltip", { fingerprint: trust.shortFingerprint })}
      >
        {t("trust.verified")}
      </Badge>
    )
  }
  if (!showUnsigned) return null
  return (
    <Badge
      variant="outline"
      className="text-[10px] text-muted-foreground"
      title={t("trust.unsignedTooltip")}
    >
      {t("trust.unsigned")}
    </Badge>
  )
}
