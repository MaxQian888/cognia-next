"use client"

import { useTranslations } from "next-intl"
import { ShieldCheckIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { useSettingsStore } from "@/stores/settings/settings-store"

/**
 * Bottom panel of the Tools settings section: lists every tool the user
 * has marked "Always allow" via past approval dialogs (or the SDK's
 * `alwaysAllowTools`). Each row has a remove button.
 */
export function AlwaysAllowList() {
  const t = useTranslations("toolSettings")
  const settings = useSettingsStore((s) => s.settings)
  const toggleAlwaysAllow = useSettingsStore((s) => s.toggleAlwaysAllow)

  const list = settings?.alwaysAllowTools ?? []

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className="h-4 w-4" />
          <CardTitle className="text-sm">{t("alwaysAllowTitle")}</CardTitle>
        </div>
        <CardDescription className="text-xs">{t("alwaysAllowDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {list.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">{t("alwaysAllowEmpty")}</div>
        ) : (
          <ScrollArea className="max-h-48">
            <ul className="flex flex-col gap-1.5">
              {list.map((toolName) => (
                <li
                  key={toolName}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1.5"
                >
                  <Badge
                    variant="secondary"
                    className="font-mono text-[10px] truncate max-w-[28ch]"
                    title={toolName}
                  >
                    {toolName}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleAlwaysAllow(toolName, false)}
                    aria-label={t("alwaysAllowRemove", { tool: toolName })}
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

export default AlwaysAllowList
