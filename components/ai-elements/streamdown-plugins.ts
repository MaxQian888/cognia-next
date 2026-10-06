import { cjk } from "@streamdown/cjk"
import { createCodePlugin } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import type { PluginConfig } from "streamdown"
import type { BundledTheme } from "shiki"
import {
  CHAT_CODE_THEME,
  resolveChatCodeTheme,
  type ChatCodeThemePair,
} from "@/lib/chat/code-theme"
import type { ChatCodeThemeId } from "@/types/appearance"

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
 * ADR-0127 / ADR-0218 — plugin set honouring the resolved
 * `messageDisplay.markdown` knobs. Streamdown treats an absent `math` /
 * `mermaid` plugin as "render as code", which is exactly the finalized
 * renderer's behaviour when `enableMath` / `enableMermaid` are off, so both
 * branches stay in lockstep. The code plugin is built for the resolved theme
 * PAIR (the same pair the finalized highlight cache keys on), so a code block
 * keeps its colours across the stream → finalize swap whichever theme is set.
 *
 * Each combination is built once and memoised, so `plugins` keeps a stable
 * identity and `<Streamdown>`'s memo does not re-parse every block per token.
 */
const codePlugins = new Map<string, NonNullable<PluginConfig["code"]>>([
  [`${CHAT_CODE_THEME.light}|${CHAT_CODE_THEME.dark}`, code],
])
const pluginSets = new Map<string, PluginConfig>()

function codePluginFor(theme: ChatCodeThemePair): NonNullable<PluginConfig["code"]> {
  const key = `${theme.light}|${theme.dark}`
  let plugin = codePlugins.get(key)
  if (!plugin) {
    plugin = createCodePlugin({
      themes: [theme.light, theme.dark] as [BundledTheme, BundledTheme],
    }) as NonNullable<PluginConfig["code"]>
    codePlugins.set(key, plugin)
  }
  return plugin
}

export function selectStreamdownPlugins(options?: {
  math?: boolean
  mermaid?: boolean
  codeTheme?: ChatCodeThemeId
}): PluginConfig {
  const mathOn = options?.math ?? true
  const mermaidOn = options?.mermaid ?? true
  const theme = resolveChatCodeTheme(options?.codeTheme)
  const key = `${mathOn ? 1 : 0}${mermaidOn ? 1 : 0}|${theme.light}|${theme.dark}`
  if (key === `11|${CHAT_CODE_THEME.light}|${CHAT_CODE_THEME.dark}`) return streamdownPlugins
  let set = pluginSets.get(key)
  if (!set) {
    set = {
      cjk,
      code: codePluginFor(theme),
      ...(mathOn ? { math } : {}),
      ...(mermaidOn ? { mermaid } : {}),
    }
    pluginSets.set(key, set)
  }
  return set
}
