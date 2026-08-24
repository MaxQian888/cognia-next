import type { Meta, StoryObj } from "@storybook/nextjs"
import * as React from "react"

import { A2UIMarkdown } from "./a2ui-markdown"
import type { A2UIMarkdownComponent } from "@/types/artifact/a2ui"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const BODY = `# Plugin runtime

The Python host speaks NDJSON over stdio. A plugin call is one \`request\`
frame; a call *back* into the host is a \`host_request\` frame on the same pipe.

## Frames

| Frame | Direction | Carries |
| --- | --- | --- |
| \`request\` | host → plugin | tool name and params |
| \`host_request\` | plugin → host | namespace, method, params |

\`\`\`python
async def summarize(ctx, params):
    return await ctx.agent.run(prompt=params["prompt"])
\`\`\`

> [!NOTE]
> Outbound calls are gated per plugin, default 8 concurrent.
`

const DIAGRAM = `## Reverse RPC

\`\`\`mermaid
sequenceDiagram
    Host->>Plugin: request
    Plugin->>Host: host_request (agent.run)
    Host-->>Plugin: host_response
    Plugin-->>Host: response
\`\`\`
`

const markdown = (over: Partial<A2UIMarkdownComponent> = {}): A2UIMarkdownComponent => ({
  id: "markdown",
  component: "Markdown",
  content: BODY,
  ...over,
})

const meta = {
  title: "A2UI/Display/Markdown",
  component: A2UIMarkdown,
  decorators: [
    (Story: React.ComponentType) => (
      <div className="max-w-2xl rounded-lg border p-4">{<Story />}</div>
    ),
  ],
} satisfies Meta<typeof A2UIMarkdown>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(markdown()) }

export const ChatRhythm: Story = { args: makeA2UIProps(markdown({ rhythm: "chat" })) }

export const WithMermaid: Story = { args: makeA2UIProps(markdown({ content: DIAGRAM })) }

export const PlainCode: Story = {
  args: makeA2UIProps(markdown({ mermaid: false, math: false, codeLineNumbers: false })),
}
