"use client"

// Discover's contribution to the page header's second tier.
//
// `plugin-section-toolbar.tsx` was written to collect four bespoke controls
// into one, and its own file comment names "the marketplace rendered a
// horizontally-scrolling ToggleGroup" as one of the four. That migration never
// happened: Discover kept drawing its own Card toolbar inside the center pane,
// which cost a band of vertical space, put the search box in a different place
// from every other section, and left the page header empty on this section.
//
// The eight-item switch it drew also collapsed two orthogonal questions onto
// one axis. Curation (which ranking) and origin (which registry) are separate
// controls now and compose as AND, so "featured, from the Cognia registry" and
// "everything Open VSX has" are both askable. `curationAnswerableBy` decides
// when the ranking control has nothing to say, and it is disabled with the
// reason rather than hidden.

import { useTranslations } from "next-intl"
import { ArrowDownUpIcon } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  curationAnswerableBy,
  usePluginsStore,
  type PluginDiscoverCuration,
  type PluginDiscoverOrigin,
} from "@/stores/plugins"

import { PluginSectionToolbar, type PluginSectionToolbarProps } from "../plugin-section-toolbar"

const CURATIONS: readonly PluginDiscoverCuration[] = ["all", "featured", "popular", "recent"]
const ORIGINS: readonly PluginDiscoverOrigin[] = [
  "all",
  "registry",
  "builtin",
  "workspace",
  "vscode",
]

export interface PluginDiscoverHeaderProps {
  layout?: PluginSectionToolbarProps["layout"]
}

/**
 * No result count in the status slot on purpose. The counts depend on both
 * axes and on which registry answered, so only the pane can compute them, and
 * the pane already states them on its own "Load more (shown / total)" control.
 * A second copy up here would be one more thing that can disagree.
 */
export function PluginDiscoverHeader({ layout }: PluginDiscoverHeaderProps = {}) {
  const t = useTranslations("plugins.discover")
  const tMarket = useTranslations("plugins.marketplace")
  const query = usePluginsStore((s) => s.filters.query)
  const setQuery = usePluginsStore((s) => s.setQuery)
  const curation = usePluginsStore((s) => s.discoverCuration)
  const origin = usePluginsStore((s) => s.discoverOrigin)
  const setCuration = usePluginsStore((s) => s.setDiscoverCuration)
  const setOrigin = usePluginsStore((s) => s.setDiscoverOrigin)

  const curationEnabled = curationAnswerableBy(origin)

  const curationSelect = (
    <Select
      value={curation}
      onValueChange={(v) => setCuration(v as PluginDiscoverCuration)}
      disabled={!curationEnabled}
    >
      <SelectTrigger
        className="h-8 w-auto gap-1.5 text-xs"
        aria-label={t("curationLabel")}
        data-testid="plugin-discover-curation"
      >
        <ArrowDownUpIcon className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CURATIONS.map((value) => (
          <SelectItem key={value} value={value}>
            {t(`curation.${value}` as never)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <PluginSectionToolbar
      testId="plugin-discover-toolbar"
      layout={layout}
      search={{
        value: query,
        onChange: setQuery,
        placeholder: tMarket("searchPlaceholder"),
        testId: "plugin-discover-search",
      }}
      tools={
        <>
          <Select value={origin} onValueChange={(v) => setOrigin(v as PluginDiscoverOrigin)}>
            <SelectTrigger
              className="h-8 w-auto gap-1.5 text-xs"
              aria-label={t("originLabel")}
              data-testid="plugin-discover-origin"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORIGINS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`origin.${value}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {curationEnabled ? (
            curationSelect
          ) : (
            // A disabled trigger swallows pointer events, so the tooltip
            // trigger has to wrap it rather than be it.
            // Self-contained provider: the app mounts one in
            // `app/layout.tsx`, but this header is rendered by stories and
            // unit tests that have no layout above them.
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex" data-testid="plugin-discover-curation-blocked">
                    {curationSelect}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-64 text-xs">{t("curationUnavailable")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </>
      }
    />
  )
}
