import type { Meta, StoryObj } from "@storybook/nextjs"
import { LarkSetupGuide } from "./lark-setup-guide"

const meta = {
  title: "Settings/Connections/Lark setup guide",
  component: LarkSetupGuide,
  render: (args) => (
    <div className="w-[min(42rem,calc(100vw-2rem))] rounded-lg border bg-card p-4">
      <LarkSetupGuide {...args} />
    </div>
  ),
  args: {
    appId: "",
    transport: "long-connection",
    isNew: true,
    credentialsVerified: false,
    botIdentityKnown: false,
  },
} satisfies Meta<typeof LarkSetupGuide>

export default meta
type Story = StoryObj<typeof meta>

export const NewLongConnection: Story = {}
export const NewWebhook: Story = { args: { transport: "webhook" } }
export const ExistingConnection: Story = {
  args: { isNew: false, appId: "cli_example", botIdentityKnown: true },
}
export const CredentialsOnly: Story = {
  args: { appId: "cli_example", credentialsVerified: true },
}
