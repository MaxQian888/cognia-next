"use client"

/**
 * Header status for `/memory` on a paired client: the rows are the host's,
 * synced to this device, and edits go to the host.
 *
 * It takes the place of the recall chip there, because the recall chip reads
 * and edits this device's retrieval settings, which do not decide what the
 * host recalls. Saying "host memory" up front is what makes the rest of the
 * page legible — why a change can take a moment to settle, why there is no
 * vector coverage figure, why Health checks a copy.
 */

import { useTranslations } from "next-intl"
import { CloudIcon, CloudOffIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { cn } from "@/lib/utils"

export function MemoryHostChip({ className }: { className?: string }) {
  const t = useTranslations("memory.host")
  const connection = useRuntimeSnapshot().connectionState
  const online = connection === "online"
  const Icon = online ? CloudIcon : CloudOffIcon

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-7 gap-1.5 px-2", className)}
          data-testid="memory-host-chip"
          data-connection={connection}
        >
          <Badge variant={online ? "secondary" : "outline"} className="gap-1 font-normal">
            <Icon className="size-3" aria-hidden />
            {t("label")}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 text-sm">
        <p className="font-medium">{t("title")}</p>
        <p className="text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-muted-foreground">
          {online ? t("online") : connection === "connecting" ? t("connecting") : t("offline")}
        </p>
      </PopoverContent>
    </Popover>
  )
}
