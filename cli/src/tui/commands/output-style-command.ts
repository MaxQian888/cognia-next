/**
 * `/output-style` — switch the agent's response mode (Claude Code parity).
 *
 *   /output-style                 open the style picker (reuses the select overlay)
 *   /output-style <name>          set the style (default|concise|explanatory|learning)
 *
 * Pure handler: it returns an `outputStyle` effect the App persists (to
 * config.json), live-applies via the reducer, and re-resolves SendOptions for —
 * the style appends an instruction to the system prompt. Mirrors `/mascot`.
 */
import { OUTPUT_STYLES, type OutputStyle } from "../../config/schema"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function handle(ctx: CommandContext): CommandEffect {
  const value = ctx.args.trim().toLowerCase()
  if (!value) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Output style",
        items: OUTPUT_STYLES.map((s) => ({
          id: s,
          label: s,
          hint: (ctx.config.outputStyle ?? "default") === s ? "current" : undefined,
        })),
        index: 0,
        onSelectCommand: "output-style",
      },
    }
  }
  if (!(OUTPUT_STYLES as readonly string[]).includes(value)) {
    return {
      kind: "notice",
      message: `Unknown output style "${value}" — choose: ${OUTPUT_STYLES.join(", ")}`,
    }
  }
  return { kind: "outputStyle", style: value as OutputStyle }
}

export const outputStyleCommand: CommandDescriptor = {
  name: "output-style",
  aliases: ["outputstyle"],
  description: "switch the agent's response mode (concise / explanatory / learning)",
  category: "config",
  argumentHint: "[default | concise | explanatory | learning]",
  handler: handle,
}
