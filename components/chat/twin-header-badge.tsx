"use client"

/**
 * Compact twin status badge for the chat header.
 *
 * Renders only when the active character is twin-bound. Hovering reveals
 * the chunk count, source count, and current RAG / few-shot toggle state;
 * clicking opens the workbench filtered to this twin.
 *
 * Designed to be a drop-in next to the model + skills badges — keeps the
 * 10–11 px font size and pill shape used elsewhere in the header.
 */

import Link from "next/link"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { BrainCircuitIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { countTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { DEFAULT_TWIN_SETTINGS, type TwinSettings } from "@/types/twin"

interface Props {
  twinId: string
  /** Per-character override; falls back to DEFAULT_TWIN_SETTINGS. */
  twinSettings?: Partial<TwinSettings>
}

export function TwinHeaderBadge({ twinId, twinSettings }: Props) {
  const t = useTranslations("chat.twinBadge")
  const chunks = useLiveQuery(() => countTwinChunksByTwin(twinId), [twinId], 0)
  const sources = useLiveQuery(
    async () => (await listTwinSourcesByTwin(twinId)).length,
    [twinId],
    0
  )
  const settings: TwinSettings = {
    enableRag: twinSettings?.enableRag ?? DEFAULT_TWIN_SETTINGS.enableRag,
    ragTopK: twinSettings?.ragTopK ?? DEFAULT_TWIN_SETTINGS.ragTopK,
    enableStyleFewShot:
      twinSettings?.enableStyleFewShot ?? DEFAULT_TWIN_SETTINGS.enableStyleFewShot,
    styleSamplesK: twinSettings?.styleSamplesK ?? DEFAULT_TWIN_SETTINGS.styleSamplesK,
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={`/twin?twinId=${encodeURIComponent(twinId)}&tab=settings`}
          aria-label={t("openWorkbench")}
        >
          <Badge variant="outline" className="font-mono text-[10px]">
            <BrainCircuitIcon className="mr-1 size-3" aria-hidden />
            {t("label", { chunks })}
          </Badge>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs space-y-1">
        <p className="text-xs">
          <strong>{twinId}</strong>
        </p>
        <p className="text-muted-foreground text-xs">{t("statSummary", { sources, chunks })}</p>
        <p className="text-muted-foreground text-xs">
          {settings.enableRag ? t("ragOn", { topK: settings.ragTopK }) : t("ragOff")}
        </p>
        <p className="text-muted-foreground text-xs">
          {settings.enableStyleFewShot
            ? t("fewShotOn", { k: settings.styleSamplesK })
            : t("fewShotOff")}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}
