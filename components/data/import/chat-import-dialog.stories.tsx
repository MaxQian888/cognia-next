import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChatImportDialog } from "./chat-import-dialog"
import { Button } from "@/components/ui/button"

// Imports an external chat export (ChatGPT / Claude / Gemini). `defaultPlatform`
// just pre-selects the copy. Controlled `open` renders the dialog body.
const meta = {
  title: "Data/ChatImportDialog",
  component: ChatImportDialog,
  args: {
    trigger: <Button variant="outline">Import chats</Button>,
    open: true,
    onOpenChange: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ChatImportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const ChatGptPreset: Story = { args: { defaultPlatform: "chatgpt" } }

export const ClaudePreset: Story = { args: { defaultPlatform: "claude" } }
