import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrDetailPanel } from "./ocr-detail-panel"

// Pure presentational panel: header (icon + name + category + status pill +
// enable switch) plus Config/Models/Advanced tabs, with optional Capabilities
// and Try-It tabs. The tab bodies are arbitrary ReactNodes supplied by the
// parent, so the stories pass simple placeholders.
const TabBody = ({ label }: { label: string }) => (
  <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">{label}</div>
)

const meta = {
  title: "Settings/Ocr/OcrDetailPanel",
  component: OcrDetailPanel,
  args: {
    provider: { id: "mistral-ocr", name: "Mistral OCR", category: "document-cloud" },
    status: "connected",
    isEnabled: true,
    onToggleEnabled: fn(),
    configTab: <TabBody label="Config tab content" />,
    modelsTab: <TabBody label="Models tab content" />,
    advancedTab: <TabBody label="Advanced tab content" />,
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-full flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OcrDetailPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const Disabled: Story = {
  args: { isEnabled: false, status: "not-configured" },
}

export const ErrorStatus: Story = {
  args: { status: "error" },
}

export const UnsupportedStatus: Story = {
  args: { status: "unsupported", isEnabled: false },
}

/** With the optional Capabilities + Try-It tabs present. */
export const AllTabs: Story = {
  args: {
    provider: { id: "anthropic-vision", name: "Claude (vision)", category: "llm-vision" },
    status: "ready",
    capabilitiesTab: <TabBody label="Capability matrix" />,
    tryItTab: <TabBody label="Playground" />,
  },
}
