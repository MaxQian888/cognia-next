import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"

import { A2UIAlert } from "./a2ui-alert"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import type { A2UIAlertComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const alert = (over: Partial<A2UIAlertComponent> = {}): A2UIAlertComponent => ({
  id: "alert",
  component: "Alert",
  title: "Heads up",
  message: "Your changes have been saved.",
  ...over,
})

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/Alert",
  component: A2UIAlert,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIAlert>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(alert()) }

export const Info: Story = {
  args: makeA2UIProps(
    alert({ variant: "info", title: "New release", message: "Version 2.4 is now available." })
  ),
}

export const Success: Story = {
  args: makeA2UIProps(
    alert({ variant: "success", title: "Saved", message: "Your profile was updated." })
  ),
}

export const Warning: Story = {
  args: makeA2UIProps(
    alert({
      variant: "warning",
      title: "Approaching limit",
      message: "You have used 90% of your monthly quota.",
    })
  ),
}

export const ErrorVariant: Story = {
  args: makeA2UIProps(
    alert({
      variant: "error",
      title: "Upload failed",
      message: "The file exceeds the 25 MB limit.",
    })
  ),
}

export const Destructive: Story = {
  args: makeA2UIProps(
    alert({
      variant: "destructive",
      title: "Account deletion",
      message: "This action is permanent and cannot be undone.",
    })
  ),
}

export const WithoutIcon: Story = {
  args: makeA2UIProps(
    alert({ variant: "info", message: "A concise notice without an icon.", showIcon: false })
  ),
}

export const MessageOnly: Story = {
  args: makeA2UIProps(alert({ title: undefined, message: "A standalone message with no title." })),
}

export const Dismissible: Story = {
  args: makeA2UIProps(
    alert({
      variant: "info",
      title: "Tip",
      message: "You can dismiss this alert with the close button.",
      dismissible: true,
      dismissAction: "dismiss-alert",
    })
  ),
}
