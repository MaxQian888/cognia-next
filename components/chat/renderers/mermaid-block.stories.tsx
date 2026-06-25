import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { MermaidBlock } from "./mermaid-block"

const FLOWCHART = `graph TD
  A[Start] --> B{Is it valid?}
  B -->|Yes| C[Process]
  B -->|No| D[Reject]
  C --> E[Done]
  D --> E`

const SEQUENCE = `sequenceDiagram
  participant U as User
  participant S as Server
  U->>S: Request
  S-->>U: Response`

const meta = {
  title: "Chat/Renderers/MermaidBlock",
  component: MermaidBlock,
  args: { content: FLOWCHART },
  parameters: { layout: "padded" },
} satisfies Meta<typeof MermaidBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Flowchart: Story = {}

export const Sequence: Story = { args: { content: SEQUENCE } }

// Invalid syntax renders the error/retry state.
export const InvalidSyntax: Story = {
  args: { content: "graph TD\n  A --> --> broken" },
}
