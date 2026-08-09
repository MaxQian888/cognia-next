/**
 * `/statusbar` — customize the footer's segments + color theme.
 *
 *   /statusbar                     open the theme picker (reuses the select overlay)
 *   /statusbar theme <name>        set the color theme (default|dim|vivid|mono)
 *   /statusbar segments a,b,c      set which segments show, in order
 *   /statusbar reset               restore the default layout + theme
 *
 * Pure handler: it returns a `statusBar` effect the App persists (to config.json)
 * and live-applies via the reducer. The theme picker re-dispatches
 * `/statusbar theme <id>` through the generic select overlay — no bespoke wiring.
 */
import {
  DEFAULT_STATUS_SEGMENTS,
  STATUS_SEGMENTS,
  STATUS_THEMES,
  type StatusSegment,
  type StatusTheme,
} from "../../config/schema"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim()
  if (!args) {
    const currentSegments = ctx.config.statusBar?.segments ?? DEFAULT_STATUS_SEGMENTS
    const currentTheme = ctx.config.statusBar?.theme ?? "default"
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Customize status bar",
        items: [
          ...(["minimal", "balanced", "detailed"] as const).map((preset) => ({
            id: `preset ${preset}`,
            label: `Layout: ${preset}`,
          })),
          ...STATUS_THEMES.map((theme) => ({
            id: `theme ${theme}`,
            label: `Theme: ${theme}`,
            hint: currentTheme === theme ? "current" : undefined,
          })),
          ...STATUS_SEGMENTS.map((segment) => ({
            id: `toggle ${segment}`,
            label: `${currentSegments.includes(segment) ? "✓" : " "} Segment: ${segment}`,
            hint: currentSegments.includes(segment) ? "shown" : "hidden",
          })),
          {
            id: `hints ${ctx.config.statusBar?.showHints === false ? "on" : "off"}`,
            label: "Idle command hints",
            hint: ctx.config.statusBar?.showHints === false ? "hidden" : "shown",
          },
          { id: "reset", label: "Reset to defaults" },
        ],
        index: 0,
        onSelectCommand: "statusbar",
      },
    }
  }

  const [verb, ...rest] = args.split(/\s+/)
  const value = rest.join(" ").trim()
  switch (verb.toLowerCase()) {
    case "theme": {
      if (!(STATUS_THEMES as readonly string[]).includes(value)) {
        return {
          kind: "notice",
          message: `Unknown theme "${value}" — choose: ${STATUS_THEMES.join(", ")}`,
        }
      }
      return { kind: "statusBar", patch: { theme: value as StatusTheme } }
    }
    case "segments": {
      const ids = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const invalid = ids.filter((id) => !(STATUS_SEGMENTS as readonly string[]).includes(id))
      if (ids.length === 0 || invalid.length > 0) {
        return {
          kind: "notice",
          message: `Segments: ${STATUS_SEGMENTS.join(", ")}. Use: /statusbar segments model,mode,ctx,cost`,
        }
      }
      return { kind: "statusBar", patch: { segments: ids as StatusSegment[] } }
    }
    case "toggle": {
      if (!(STATUS_SEGMENTS as readonly string[]).includes(value)) {
        return { kind: "notice", message: `Unknown segment "${value}"` }
      }
      const segment = value as StatusSegment
      const current = ctx.config.statusBar?.segments ?? DEFAULT_STATUS_SEGMENTS
      const segments = current.includes(segment)
        ? current.filter((id) => id !== segment)
        : [...current, segment]
      if (segments.length === 0) {
        return { kind: "notice", message: "The status bar needs at least one segment" }
      }
      return { kind: "statusBar", patch: { segments } }
    }
    case "preset": {
      const presets: Record<string, StatusSegment[]> = {
        minimal: ["model", "mode", "ctx"],
        balanced: [...DEFAULT_STATUS_SEGMENTS],
        detailed: [...STATUS_SEGMENTS],
      }
      const segments = presets[value]
      return segments
        ? { kind: "statusBar", patch: { segments } }
        : { kind: "notice", message: "Presets: minimal, balanced, detailed" }
    }
    case "hints":
      if (value !== "on" && value !== "off") {
        return { kind: "notice", message: "Usage: /statusbar hints <on|off>" }
      }
      return { kind: "statusBar", patch: { showHints: value === "on" } }
    case "reset":
      return {
        kind: "statusBar",
        patch: { segments: [...DEFAULT_STATUS_SEGMENTS], theme: "default", showHints: true },
      }
    default:
      return {
        kind: "notice",
        message:
          "Usage: /statusbar [theme <name> | preset <name> | toggle <segment> | segments <a,b,c> | hints <on|off> | reset]",
      }
  }
}

export const statusbarCommand: CommandDescriptor = {
  name: "statusbar",
  description: "customize status-bar layout, segments, theme and hints",
  category: "config",
  argumentHint: "[theme|preset|toggle|segments|hints|reset]",
  handler: handle,
}
