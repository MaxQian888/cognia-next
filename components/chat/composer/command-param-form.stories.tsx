import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CommandParamForm } from "./command-param-form"
import type { SlashCommand } from "@/lib/slash-commands/builtin"

// CommandParamForm is the guided form a slash command with `params` opens
// instead of inserting raw text. It self-gates open when `command` is non-null
// AND declares at least one param, so every story passes a param-bearing
// command. On confirm it builds the args string via `buildArgs` and hands it
// to `onSubmit`. No store/provider needed — it's a controlled Dialog.

// A command exercising every param kind: free-text, enum select, number, and
// a boolean switch — plus one required field so the missing-required guard is
// reachable.
const ocrCommand: SlashCommand = {
  name: "ocr",
  description: "Extract text from an image or PDF.",
  scope: "builtin",
  params: [
    {
      name: "source",
      label: "Source file",
      type: "string",
      required: true,
      placeholder: "/path/to/scan.pdf",
    },
    {
      name: "lang",
      label: "Language",
      type: "enum",
      options: ["en", "zh", "ja", "auto"],
      default: "auto",
    },
    { name: "dpi", label: "DPI", type: "number", default: "300" },
    { name: "tables", label: "Detect tables", type: "boolean" },
  ],
}

const meta = {
  title: "Chat/Composer/CommandParamForm",
  component: CommandParamForm,
  parameters: { layout: "padded" },
  args: { onSubmit: fn(), onCancel: fn() },
} satisfies Meta<typeof CommandParamForm>

export default meta
type Story = StoryObj<typeof meta>

// Dialog open with the full mix of field types; leaving the required "Source
// file" blank and pressing Insert surfaces the inline validation error.
export const FullForm: Story = {
  args: { command: ocrCommand },
}

// A single required free-text param — the minimal guided-form shape.
export const SingleRequired: Story = {
  args: {
    command: {
      name: "goal",
      description: "Create a tracked goal.",
      scope: "builtin",
      params: [
        {
          name: "title",
          label: "Goal title",
          type: "string",
          required: true,
          placeholder: "Ship the composer toolbar",
        },
      ],
    },
  },
}
