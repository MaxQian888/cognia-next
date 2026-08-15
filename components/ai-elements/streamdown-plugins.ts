import { cjk } from "@streamdown/cjk"
import { createCodePlugin } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import type { PluginConfig } from "streamdown"
import { CHAT_CODE_THEME } from "@/lib/chat/code-theme"

/**
 * Shared Streamdown plugin set for streaming chat surfaces (assistant
 * responses + reasoning).
 *
 * The code plugin is configured with `CHAT_CODE_THEME` instead of Streamdown's
 * `github-light`/`github-dark` default, so streaming code blocks are coloured
 * identically to the finalized `components/chat/renderers/code-block.tsx` view.
 * Without this, every code block visibly recoloured the instant a message
 * stopped streaming and re-rendered through react-markdown.
 *
 * Lives under `ai-elements/` (vendored, coverage-excluded) but is first-party
 * glue; the theme contract it depends on is guarded by
 * `lib/chat/code-theme.test.ts`.
 */
const code = createCodePlugin({
  themes: [CHAT_CODE_THEME.light, CHAT_CODE_THEME.dark],
}) as NonNullable<PluginConfig["code"]>

export const streamdownPlugins = {
  cjk,
  code,
  math,
  mermaid,
} satisfies PluginConfig

/**
 * ADR-0127 — plugin set honouring the resolved `messageDisplay.markdown`
 * toggles. Streamdown treats an absent `math` / `mermaid` plugin as "render as
 * code", which is exactly the finalized renderer's behaviour when
 * `enableMath` / `enableMermaid` are off, so both branches stay in lockstep.
 * The four variants are built once so `plugins` keeps a stable identity and
 * `<Streamdown>`'s memo does not re-parse every block on each token.
 */
const PLUGIN_VARIANTS: Record<string, PluginConfig> = {
  "math+mermaid": streamdownPlugins,
  math: { cjk, code, math },
  mermaid: { cjk, code, mermaid },
  none: { cjk, code },
}

export function selectStreamdownPlugins(options?: {
  math?: boolean
  mermaid?: boolean
}): PluginConfig {
  const mathOn = options?.math ?? true
  const mermaidOn = options?.mermaid ?? true
  if (mathOn && mermaidOn) return PLUGIN_VARIANTS["math+mermaid"]
  if (mathOn) return PLUGIN_VARIANTS.math
  if (mermaidOn) return PLUGIN_VARIANTS.mermaid
  return PLUGIN_VARIANTS.none
}
