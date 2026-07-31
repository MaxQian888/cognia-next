import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrSidebarItem } from "./ocr-sidebar-item"

// Pure presentational row. `onClick` receives the providerId. The capability
// micro-badges are derived from the providerId via `topSidebarCapabilities`,
// so the chosen id (mistral-ocr) drives which icons appear.
const meta = {
  title: "Settings/Ocr/OcrSidebarItem",
  component: OcrSidebarItem,
  args: {
    providerId: "mistral-ocr",
    name: "Mistral OCR",
    subtitle: "Document OCR (cloud)",
    status: "connected",
    isSelected: false,
    statusLabel: "Connected",
    onClick: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OcrSidebarItem>

export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const Ready: Story = {
  args: {
    providerId: "ocrs",
    name: "ocrs (local)",
    subtitle: "On-device",
    status: "ready",
    statusLabel: "Ready",
  },
}

export const NotConfigured: Story = {
  args: {
    providerId: "google-vision",
    name: "Google Vision",
    status: "not-configured",
    statusLabel: "Not configured",
  },
}

export const Error: Story = {
  args: {
    providerId: "mathpix",
    name: "Mathpix",
    subtitle: "Specialist",
    status: "error",
    statusLabel: "Error",
  },
}

export const Unsupported: Story = {
  args: {
    providerId: "windows-media-ocr",
    name: "Windows Media OCR",
    subtitle: "On-device",
    status: "unsupported",
    statusLabel: "Unsupported",
  },
}

export const Selected: Story = {
  args: { isSelected: true },
}

export const Disabled: Story = {
  args: { disabled: true, statusLabel: "Connected" },
}

export const IconOverride: Story = {
  args: {
    providerId: "custom",
    name: "Custom provider",
    subtitle: "Bring your own",
    status: "ready",
    statusLabel: "Ready",
    icon: <span aria-hidden>★</span>,
  },
}
