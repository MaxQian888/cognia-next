/**
 * `/route` — inspect and toggle opt-in automatic tier routing.
 *
 * `/route` (bare) prints the current auto-routing state + the tier ladder.
 * `/route auto on|off` toggles the `autoRoute` config flag (persisted +
 * live-merged; the next resolved turn honors it). Auto routing scores a
 * prompt's difficulty and routes it to the cheapest capable tier alias
 * (fast/balanced/powerful), seeded from the enabled providers.
 *
 * NOTE: per-prompt routing applies to one-shot / headless `run` turns (the
 * prompt is known when options resolve). The persistent interactive session
 * resolves its model once at session start and is bound to one dispatcher, so
 * a fresh session picks up the toggle — but a single live session does not
 * re-route each turn. Pure handler; the App interprets the returned effect.
 */
import { DEFAULT_AUTO_ROUTING } from "@/types/routing/tool-route"

import type { CommandDescriptor, CommandEffect, CommandContext } from "./types"

function statusNotice(ctx: CommandContext): CommandEffect {
  const on = ctx.config.autoRoute === true
  const tiers = DEFAULT_AUTO_ROUTING.candidateAliases.join(" → ")
  return {
    kind: "notice",
    message: on
      ? `Auto routing is ON. Difficulty-scored tier ladder: ${tiers}. Applies to one-shot/headless runs; a fresh interactive session picks up the setting. Toggle with /route auto off.`
      : `Auto routing is OFF. Turn it on with /route auto on to route each prompt to the cheapest capable tier (${tiers}).`,
  }
}

function toggle(value: boolean): CommandEffect {
  return { kind: "flag", key: "autoRoute", value }
}

export const routeCommand: CommandDescriptor = {
  name: "route",
  description: "Inspect or toggle automatic model tier routing",
  category: "config",
  argumentHint: "[auto on|off]",
  subcommands: [
    {
      name: "auto",
      description: "Enable or disable automatic tier routing (on|off)",
      argumentHint: "on|off",
      handler: (ctx) => {
        const arg = ctx.args.trim().toLowerCase()
        if (arg === "on" || arg === "true" || arg === "enable") return toggle(true)
        if (arg === "off" || arg === "false" || arg === "disable") return toggle(false)
        // No/unknown arg → toggle relative to the current state.
        if (arg === "") return toggle(ctx.config.autoRoute !== true)
        return { kind: "notice", message: "Usage: /route auto on|off" }
      },
    },
  ],
  handler: (ctx) => statusNotice(ctx),
}
