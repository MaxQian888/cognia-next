import type { Meta, StoryObj } from "@storybook/nextjs"

import { HelperHints } from "./helper-hints"

// HelperHints is a pure presentational chip row — it only reads i18n strings.
// Note: the component self-hides below the `sm` viewport and the `@sm/composer`
// container breakpoint, so it renders inside a wide `@container` named
// "composer" so the hints are actually visible in the preview.
const meta = {
  title: "Chat/Composer/HelperHints",
  component: HelperHints,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/composer w-full max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HelperHints>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
