import type { Meta, StoryObj } from "@storybook/nextjs"

import { VersionRow, type VersionRowProps } from "./version-row"

// About-section version row. The native build number comes from an injectable
// loader (defaults to `@capacitor/app`, which rejects off-device → version
// only). Stories drive both branches.
const meta = {
  title: "Mobile/Me/VersionRow",
  component: VersionRow,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px] overflow-hidden rounded-xl border bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<VersionRowProps>

export default meta
type Story = StoryObj<typeof meta>

export const PackageVersionOnly: Story = {
  args: { loader: async () => null },
}

export const WithNativeBuild: Story = {
  args: { loader: async () => "320" },
}
