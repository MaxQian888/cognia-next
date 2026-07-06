import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DomainListInput } from "./domain-list-input"

// `DomainListInput` is a pure props-only control: type a domain and press Enter
// (or the add button) to emit `onAdd`; each existing domain renders a removable
// badge. It owns only its draft/error local state. An optional `validate` gate
// can reject a draft and surface an error message.
const meta = {
  title: "Settings/Search/Shared/DomainListInput",
  component: DomainListInput,
  parameters: { layout: "padded" },
  args: {
    label: "Included domains",
    placeholder: "example.com",
    domains: [],
    onAdd: fn(),
    onRemove: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DomainListInput>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const Populated: Story = {
  args: {
    domains: ["wikipedia.org", "arxiv.org", "nature.com"],
    removeAriaLabel: (d) => `Remove ${d}`,
  },
}

// `showAddButton` renders an explicit + button next to the input.
export const WithAddButton: Story = {
  args: {
    label: "Trusted domains",
    domains: ["gov.uk", "who.int"],
    showAddButton: true,
  },
}

// `scrollable` caps the badge area height for long lists.
export const ScrollableLongList: Story = {
  args: {
    label: "Blocked domains",
    showAddButton: true,
    scrollable: true,
    domains: [
      "spam.example",
      "ads.example",
      "tracker.example",
      "malware.example",
      "phishing.example",
      "lowquality.example",
      "clickbait.example",
      "fake-news.example",
    ],
  },
}

// `validate` can reject a draft; the returned key is rendered via `errorRender`.
export const WithValidation: Story = {
  args: {
    label: "Domain with validation",
    validate: (draft) => (draft.includes(".") ? null : "invalidDomain"),
    errorRender: (key) =>
      key === "invalidDomain" ? "Enter a valid domain (must contain a dot)" : key,
  },
}
