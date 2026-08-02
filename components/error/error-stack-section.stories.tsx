import type { Meta, StoryObj } from "@storybook/nextjs"

import { ErrorStackSection } from "./error-stack-section"

const copy = {
  title: "Error details",
  showStack: "Show stack trace",
  hideStack: "Hide stack trace",
}

// Flat detail section used inside the error page's scrollable band — no card
// chrome of its own, so it renders here on the plain page background.
const meta = {
  title: "Error/ErrorStackSection",
  component: ErrorStackSection,
  args: { copy },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ErrorStackSection>

export default meta
type Story = StoryObj<typeof meta>

export const WithStack: Story = {
  args: {
    error: {
      message: "GROUP_HEADING_CLASS is not defined",
      stack:
        "ReferenceError: GROUP_HEADING_CLASS is not defined\n" +
        "    at CommandGroup (components/ui/command.tsx:118:24)\n" +
        "    at renderWithHooks (react-dom-client.development.js:15012:18)\n" +
        "    at updateFunctionComponent (react-dom-client.development.js:19617:20)",
    },
  },
}

export const MessageOnly: Story = {
  args: { error: { message: "Failed to fetch" } },
}
