import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { DiffBlock } from "./diff-block"

const DIFF = `@@ -1,6 +1,7 @@
 export function greet(name) {
-  return "Hi " + name
+  const trimmed = name.trim()
+  return \`Hello, \${trimmed}!\`
 }

 export const VERSION = "1.0.0"`

const meta = {
  title: "Chat/Renderers/DiffBlock",
  component: DiffBlock,
  args: { content: DIFF, filename: "greet.ts" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof DiffBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Unified: Story = {}

export const Renamed: Story = {
  args: { oldFilename: "greet.js", newFilename: "greet.ts", filename: undefined },
}

export const AdditionsOnly: Story = {
  args: {
    filename: "new-file.ts",
    content: `@@ -0,0 +1,3 @@
+export const a = 1
+export const b = 2
+export const c = 3`,
  },
}
