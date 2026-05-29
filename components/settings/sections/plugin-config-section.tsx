"use client"

// Global "Plugin configuration" Settings section.
//
// Aggregates every enabled plugin that exposes a config surface and renders
// the SAME inline form the per-plugin detail pane uses
// (`PluginConfigFormContent variant="inline"`), so configuring a plugin no
// longer requires navigating into the /plugins workspace. No new manifest
// field, no form re-implementation — purely a new read surface over existing
// config data. Each plugin's form is mounted lazily (only when its accordion
// item is expanded) so N plugins don't all mount heavy forms at once.

import Link from "next/link"
import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { listEnabledPlugins } from "@/lib/db/plugins"
import { PluginConfigFormContent } from "@/components/plugins/detail/plugin-config-form"
import { filterConfigurablePlugins } from "./plugin-config-utils"

export function PluginConfigSection() {
  const t = useTranslations("settings.pluginConfig")
  const plugins = useLiveQuery(() => listEnabledPlugins(), [])
  const [expanded, setExpanded] = useState<string>("")

  const configurable = plugins ? filterConfigurablePlugins(plugins) : []
  const loading = plugins === undefined

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-base">{t("title")}</Label>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {loading ? null : configurable.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <SlidersHorizontalIcon className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("emptyHint")}</p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href="/plugins">{t("manageAll")}</Link>
          </Button>
        </Card>
      ) : (
        <Accordion
          type="single"
          collapsible
          value={expanded}
          onValueChange={setExpanded}
          className="space-y-2"
        >
          {configurable.map((plugin) => (
            <AccordionItem key={plugin.id} value={plugin.id} className="rounded-lg border px-3">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{plugin.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("versionLabel", { version: plugin.version })}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                {expanded === plugin.id ? (
                  <PluginConfigFormContent
                    pluginId={plugin.id}
                    onClose={() => undefined}
                    variant="inline"
                  />
                ) : null}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  )
}
