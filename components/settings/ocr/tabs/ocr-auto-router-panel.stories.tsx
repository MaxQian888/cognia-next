import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrAutoRouterPanel } from "./ocr-auto-router-panel"
import { AUTO_ROUTER_PROVIDERS, makeOcrSettings } from "@/lib/storybook/fixtures/settings-ocr-tabs"

// Props-driven panel. The "Cache" sub-tab nests `OcrCacheTab`, which reads the
// Dexie `ocrResults` table via `useLiveQuery` — Storybook opens a real (empty)
// IndexedDB, so it renders its empty state without crashing. The panel is
// `h-full`, so wrap it in a fixed-height box.
const meta = {
  title: "Settings/Ocr/Tabs/OcrAutoRouterPanel",
  component: OcrAutoRouterPanel,
  args: {
    settings: makeOcrSettings(),
    onChange: fn(),
    providers: AUTO_ROUTER_PROVIDERS,
    onClearCache: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OcrAutoRouterPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Header gains the "Run setup wizard" button when `onOpenWizard` is supplied.
export const WithWizard: Story = {
  args: { onOpenWizard: fn() },
}

// Cloud fallback off → the fallback-provider Select is disabled.
export const CloudFallbackDisabled: Story = {
  args: {
    settings: makeOcrSettings({ cloudFallbackEnabled: false, cloudFallbackProviderId: null }),
  },
}

// A fully customised configuration (explicit default provider, no PDF fast-path,
// confidence escalation on, short cache TTL).
export const CustomDefaults: Story = {
  args: {
    settings: makeOcrSettings({
      defaultProviderId: "mistral-ocr",
      defaultFormat: "text",
      defaultLanguages: ["en", "zh"],
      pdfTextLayerFastPath: false,
      confidenceEscalation: "escalate",
      cacheTtlDays: 7,
      maxImageDimension: 3072,
    }),
  },
}
