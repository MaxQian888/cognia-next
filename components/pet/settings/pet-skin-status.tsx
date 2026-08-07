"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import type { PetAssetDiagnostic, PetSkinId } from "@/types/pet"

export interface PetSkinStatusProps {
  requestedSkinId: string
  effectiveSkinId: PetSkinId
  diagnostics: readonly PetAssetDiagnostic[]
  onRetry?: () => void
  onConfigure?: () => void
}

/** Explicitly explains governed skin fallback instead of silently drawing SVG. */
export function PetSkinStatus({
  requestedSkinId,
  effectiveSkinId,
  diagnostics,
  onRetry,
  onConfigure,
}: PetSkinStatusProps) {
  const t = useTranslations("settings.pet.skinStatus")
  const isFallback = requestedSkinId !== effectiveSkinId
  if (!isFallback && diagnostics.length === 0) return null

  const skinName = (id: string) =>
    id === "svg" || id === "live2d" || id === "sprite-v2" ? t(`skins.${id}`) : id

  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="grid gap-1 text-xs">
        <p>{t("requested", { skin: skinName(requestedSkinId) })}</p>
        <p>{t("effective", { skin: skinName(effectiveSkinId) })}</p>
        {isFallback && (
          <p className="font-medium text-amber-700 dark:text-amber-400">{t("fallback")}</p>
        )}
      </div>

      {diagnostics.length > 0 && (
        <ul role="status" className="space-y-1 text-xs text-muted-foreground">
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`}>
              {t(`diagnostics.${diagnostic.code}`, {
                path: diagnostic.path ?? diagnostic.detail ?? t("unknownResource"),
              })}
            </li>
          ))}
        </ul>
      )}

      {(onRetry || onConfigure) && (
        <div className="flex flex-wrap gap-2">
          {onRetry && diagnostics.some((diagnostic) => diagnostic.recoverable) && (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {t("retry")}
            </Button>
          )}
          {onConfigure && (
            <Button type="button" size="sm" variant="outline" onClick={onConfigure}>
              {t("configure")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
