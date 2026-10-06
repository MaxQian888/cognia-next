import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"

import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { MessageShell } from "@/components/chat/message-shell"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import type { MessageDisplayOverrides } from "@/types/appearance"

// ADR-0218 — one assistant turn exercising every part of the chat reading
// surface: link styles and previews, inline code, highlight, an alert, a
// table, a code block, a mermaid diagram and an inline chart. Use the
// overrides to compare text size, spacing, link style, block density and the
// code theme side by side.
const SAMPLE = [
  "## Rendering audit",
  "",
  "The kit lives at https://github.com/deepseek-ai/dsh-libreoffice-kit, and the",
  "[official font notes](https://developer.mozilla.org/en-US/docs/Web/CSS/font-family)",
  "explain the fallback chain. See `lib/chat/code-theme.ts` for the theme pairs,",
  "and note the <mark>highlighted</mark> caveat.",
  "",
  "> [!TIP]",
  "> Links take the **`--link`** token now — see [the ADR](https://example.com/adr).",
  "",
  "| Surface | Before | After | Δ ms |",
  "| --- | --- | ---: | ---: |",
  "| Code block | card in card | one frame | 12 |",
  "| Table | square grid | rounded, hover | 4 |",
  "| Mermaid | stock theme | app palette | 31 |",
  "",
  "```ts",
  "export function resolveChatCodeTheme(id?: ChatCodeThemeId) {",
  "  return (id && CHAT_CODE_THEMES[id]) || CHAT_CODE_THEME",
  "}",
  "```",
  "",
  "```mermaid",
  "graph LR",
  '  A["Streaming"] --> B["Finalised"]',
  '  B --> C["Same frame"]',
  "```",
  "",
  "```chart",
  '{"type":"bar","title":"Render cost","data":[{"name":"Code","before":40,"after":12},{"name":"Table","before":9,"after":4},{"name":"Mermaid","before":55,"after":31}]}',
  "```",
].join("\n")

interface ReadingSurfaceStoryProps {
  overrides?: MessageDisplayOverrides
  content?: string
}

function ReadingSurfaceStory({ overrides, content = SAMPLE }: ReadingSurfaceStoryProps) {
  const display = resolveMessageDisplayOptions({ preset: "balanced", overrides })
  const message: UIMessage = {
    id: "reading-surface",
    role: "assistant",
    parts: [{ type: "text", text: content }],
    metadata: { createdAt: 1_700_000_000_000 },
  }
  return (
    <div className="max-w-[52rem]">
      <MessageShell message={message} display={display}>
        <MarkdownRenderer content={content} markdown={display.markdown} messageId={message.id} />
      </MessageShell>
    </div>
  )
}

const meta = {
  title: "Chat/ReadingSurface",
  component: ReadingSurfaceStory,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ReadingSurfaceStory>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const LargeRelaxed: Story = {
  args: { overrides: { reading: { textSize: "lg", spacing: "relaxed" } } },
}

export const CompactTextLinks: Story = {
  args: {
    overrides: {
      reading: { textSize: "sm", spacing: "compact" },
      links: { color: "text", underline: "hover", siteIcon: false },
    },
  },
}

export const ComfortableBlocksGithubTheme: Story = {
  args: { overrides: { markdown: { blockDensity: "comfortable", codeTheme: "github" } } },
}

export const FlushBlocks: Story = {
  args: { overrides: { markdown: { blockBorder: false, blockHeader: false } } },
}
