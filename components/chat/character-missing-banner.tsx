"use client"

import { useTranslations } from "next-intl"
import { AlertCircleIcon, RefreshCwIcon, UsersRoundIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useCharacter } from "@/lib/data-hooks/context"
import { isOverlayCharacterId } from "@/lib/plugin/registries/character-pack-registry"
import { LOCAL_PACK_PLUGIN_ID } from "@/lib/plugin/character-pack/local-pack-store"
import { usePluginMetadata } from "@/hooks/plugins/use-plugin-metadata"

interface Props {
  /** The session.characterId to resolve. */
  characterId: string | undefined | null
  /** Open the character picker so the user can pick a replacement. */
  onPickAnother?: () => void
}

/**
 * Inline alert rendered when a chat session points at a character that
 * no longer resolves (ADR-0030 §D.2). Three reasons this happens:
 *  1. The contributing plugin was disabled / uninstalled.
 *  2. The local pack file was deleted.
 *  3. A Dexie row was deleted by another device before sync (rare).
 *
 * Behaviour:
 *  - Plain Dexie ids: silent. The caller should fall back to defaults
 *    without bothering the user — there's no recovery action.
 *  - Overlay synthetic ids: render a destructive alert with a "Pick
 *    another" CTA so the user can rebind the session.
 *
 * Visual treatment mirrors `components/error/diagnostic-card.tsx` so the
 * chat surface stays homogeneous; we deliberately don't define a new
 * variant or color palette.
 */
export function CharacterMissingBanner({ characterId, onPickAnother }: Props) {
  const t = useTranslations("chat.characterMissing")
  const resolved = useCharacter(characterId ?? undefined)
  // Pre-parse the synthetic id (when present) so we can name the source
  // plugin in the message. The id format is
  // `cognia-pack:<pluginId>:<packId>:<localId>`; we only need the first
  // segment.
  const synthetic = characterId && isOverlayCharacterId(characterId)
  const pluginIdFromId =
    synthetic && characterId ? characterId.split(":")[1] || undefined : undefined
  const pluginMeta = usePluginMetadata(pluginIdFromId)

  // Nothing to show when the id is undefined or already resolved.
  if (!characterId || resolved) return null
  // For plain Dexie ids we stay silent — the chat surface falls through
  // to app defaults; there's no recovery action the user can take here.
  if (!synthetic) return null

  const sourceLabel =
    pluginIdFromId === LOCAL_PACK_PLUGIN_ID || !pluginIdFromId
      ? t("sourceLocalFile")
      : t("sourcePlugin", { name: pluginMeta?.name ?? pluginIdFromId })

  return (
    <Alert variant="destructive" role="status">
      <AlertCircleIcon className="size-4" />
      <AlertTitle className="text-sm">{t("title")}</AlertTitle>
      <AlertDescription className="space-y-2 text-xs">
        <p className="break-words">{t("body", { source: sourceLabel })}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {onPickAnother && (
            <Button variant="outline" size="sm" onClick={onPickAnother}>
              <UsersRoundIcon className="mr-1.5 size-3.5" />
              {t("action.pickAnother")}
            </Button>
          )}
          {pluginIdFromId && pluginIdFromId !== LOCAL_PACK_PLUGIN_ID && (
            <p className="inline-flex items-center text-[11px] text-destructive/80">
              <RefreshCwIcon className="mr-1 size-3" />
              {t("action.reEnablePluginHint")}
            </p>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
