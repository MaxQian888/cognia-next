import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { CLAUDE_CODE_RELATED, RelatedSectionsStrip } from "./related-sections-strip"

// `useRouter`/`useSearchParams` resolve through @storybook/nextjs' App Router
// mock (preview.tsx sets `nextjs: { appDirectory: true }`), so the chips render
// and clicks are no-ops in the canvas. The `current` section is filtered out of
// the list. Toggle the Locale toolbar to see the labels in English vs. 简体中文.
const meta = {
  title: "Settings/Common/RelatedSectionsStrip",
  component: RelatedSectionsStrip,
  args: {
    current: "subscription",
    targets: CLAUDE_CODE_RELATED,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof RelatedSectionsStrip>

export default meta
type Story = StoryObj<typeof meta>

/** The curated Claude Code strip, minus the section it lives in. */
export const Default: Story = {}

/** A hand-picked, shorter set of targets. */
export const CustomTargets: Story = {
  args: {
    current: "agent-runtime",
    targets: [
      { section: "mcp", labelKey: "mcp" },
      { section: "hooks", labelKey: "hooks" },
      { section: "tools", labelKey: "tools" },
    ],
  },
}

/** When every target equals `current`, the strip renders nothing. */
export const AllFiltered: Story = {
  args: {
    current: "mcp",
    targets: [{ section: "mcp", labelKey: "mcp" }],
  },
}
