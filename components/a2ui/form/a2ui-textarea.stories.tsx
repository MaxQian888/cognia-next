import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UITextArea } from "./a2ui-textarea"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import type { A2UITextAreaComponent } from "@/types/a2ui/schema"

const textarea = (over: Partial<A2UITextAreaComponent> = {}): A2UITextAreaComponent => ({
  id: "textarea",
  component: "TextArea",
  value: "",
  label: "Description",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Form/TextArea",
  component: A2UITextArea,
  decorators: [withA2UI],
  parameters: { layout: "padded" },
} satisfies Meta<typeof A2UITextArea>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: makeA2UIProps(textarea({ value: "", placeholder: "Tell us what happened…" }), {
    onDataChange: fn(),
  }),
}

export const Filled: Story = {
  args: makeA2UIProps(
    textarea({
      value:
        "The deployment failed during the migration step. Logs show a timeout connecting to the vector store.",
    }),
    { onDataChange: fn() }
  ),
}

export const WithHelperText: Story = {
  args: makeA2UIProps(
    textarea({
      label: "Bio",
      placeholder: "A short introduction",
      helperText: "Markdown is supported.",
      maxLength: 280,
    })
  ),
}

export const Required: Story = {
  args: makeA2UIProps(textarea({ label: "Feedback", value: "", required: true })),
}

export const Error: Story = {
  args: makeA2UIProps(
    textarea({
      label: "Summary",
      value: "Too short",
      error: "Please provide at least 20 characters.",
    })
  ),
}

export const CustomRows: Story = {
  args: makeA2UIProps(textarea({ label: "Notes", placeholder: "Spacious editor", rows: 8 })),
}

export const Disabled: Story = {
  args: makeA2UIProps(textarea({ value: "This field is read-only.", disabled: true })),
}
