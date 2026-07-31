import { cjk } from "@streamdown/cjk"
import { createCodePlugin } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
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
export const streamdownPlugins = {
  cjk,
  code: createCodePlugin({ themes: [CHAT_CODE_THEME.light, CHAT_CODE_THEME.dark] }),
  math,
  mermaid,
}
