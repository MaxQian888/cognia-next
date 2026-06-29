import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { A2UIToast, type A2UIToastComponent } from "./a2ui-toast"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { Toaster } from "@/components/ui/sonner"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const toastDescriptor = (over: Partial<A2UIToastComponent> = {}): A2UIToastComponent => ({
  id: "toast",
  component: "Toast",
  message: "Saved successfully",
  ...over,
})

// A2UIToast fires a sonner toast and renders null; it resolves its message via
// the A2UI data context, and needs a <Toaster /> mounted to be visible.
const withToast: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <div style={{ minHeight: 120, minWidth: 320 }}>
      <Story />
      <Toaster />
    </div>
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Toast",
  component: A2UIToast,
  decorators: [withToast],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIToast>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(toastDescriptor({ message: "Your draft was saved." })),
}

export const Success: Story = {
  args: makeA2UIProps(
    toastDescriptor({
      variant: "success",
      message: "Deployment complete",
      description: "Version 2.4.0 is now live.",
    })
  ),
}

export const ErrorToast: Story = {
  args: makeA2UIProps(
    toastDescriptor({
      variant: "error",
      message: "Upload failed",
      description: "The file exceeds the 25MB limit.",
    })
  ),
}

export const Warning: Story = {
  args: makeA2UIProps(
    toastDescriptor({ variant: "warning", message: "Your session expires in 5 minutes." })
  ),
}

export const Info: Story = {
  args: makeA2UIProps(toastDescriptor({ variant: "info", message: "A new version is available." })),
}

export const WithAction: Story = {
  args: makeA2UIProps(
    toastDescriptor({
      message: "Message archived",
      actionLabel: "Undo",
      action: "undo-archive",
    }),
    { onAction: fn() }
  ),
}
