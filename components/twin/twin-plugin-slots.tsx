"use client"

/**
 * Plugin extension anchors for the Employee Digital Twin workbench (ADR-0003).
 *
 * The twin panel used to be the one major surface with zero plugin mount
 * points. These four thin wrappers close that gap using the same first-class
 * mechanism every other panel uses — `<PluginExtensionSlot>` + the
 * `plugin-points.ts` contract — so a plugin can now contribute UI into the
 * twin panel's four main regions:
 *
 *   • `twin.panel.header`   — header toolbar actions (next to the twin selector)
 *   • `twin.persona.panel`  — insight panel below the persona sub-tabs
 *   • `twin.settings.cards` — an extra card at the foot of the Settings column
 *   • `twin.overview.panel` — a metric tile alongside the overview charts
 *
 * Each mount uses a **string-literal** `point` (the slot audit rejects computed
 * points) and passes a redacted `context` bag. Keeping every literal mount in
 * this single module means all four contract bindings resolve here, and the
 * tab components just render the wrapper for their region.
 *
 * PII red-line: the context bags carry only the twin id + numeric aggregates —
 * never chunk text, persona content, or source bodies (mirrors the rule on
 * `report-plugin-slot.tsx`). When no plugin is registered for a point,
 * `PluginExtensionSlot` renders `null`, so these are invisible for users
 * without a twin plugin. Contributions supply and localize their own labels
 * via `manifest.i18n`, so these wrappers carry no user-facing strings.
 */

import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

export function TwinHeaderPluginSlot({ twinId, tab }: { twinId: string; tab: string }) {
  return (
    <PluginExtensionSlot
      point="twin.panel.header"
      className="flex items-center gap-1"
      context={{ twinId, tab }}
    />
  )
}

export function TwinPersonaPluginSlot({
  twinId,
  entityCount,
  playbookCount,
  styleCount,
}: {
  twinId: string
  entityCount: number
  playbookCount: number
  styleCount: number
}) {
  return (
    <PluginExtensionSlot
      point="twin.persona.panel"
      className="flex flex-col gap-4"
      context={{ twinId, entityCount, playbookCount, styleCount }}
    />
  )
}

export function TwinSettingsPluginSlot({ twinId }: { twinId: string }) {
  return (
    <PluginExtensionSlot
      point="twin.settings.cards"
      className="flex flex-col gap-3"
      context={{ twinId }}
    />
  )
}

export function TwinOverviewPluginSlot({
  twinId,
  sourceCount,
  chunkCount,
}: {
  twinId: string
  sourceCount: number
  chunkCount: number
}) {
  return (
    <PluginExtensionSlot
      point="twin.overview.panel"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      context={{ twinId, sourceCount, chunkCount }}
    />
  )
}
