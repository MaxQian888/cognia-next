import type { Meta, StoryObj } from "@storybook/nextjs"

import { OcrModelsTab } from "./ocr-models-tab"
import { makeOcrModelBridge } from "@/lib/storybook/fixtures/settings-ocr-tabs"

// Tauri-branching, but the Rust model-manager is reachable via an injectable
// `bridge` prop. Stories pass an in-memory bridge to render the manager UI; the
// non-managed / shell-unavailable branches pass `null`.
const meta = {
  title: "Settings/Ocr/Tabs/OcrModelsTab",
  component: OcrModelsTab,
  args: { providerId: "ocrs", bridge: makeOcrModelBridge() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof OcrModelsTab>

export default meta
type Story = StoryObj<typeof meta>

// Managed backend with weights not yet downloaded → "missing files" + Download.
export const NotInstalled: Story = {}

// Managed backend with weights already installed → "Re-download" + size.
export const Installed: Story = {
  args: {
    bridge: makeOcrModelBridge({
      installed: true,
      total_bytes: 23_000_000,
      files: [
        { file_name: "text-detection.rten", installed: true, expected_bytes: 8_300_000 },
        { file_name: "text-recognition.rten", installed: true, expected_bytes: 14_700_000 },
      ],
    }),
  },
}

// Provider without managed model files → "no model files" empty state.
export const NotManaged: Story = {
  args: { providerId: "mistral-ocr", bridge: null },
}

// Managed backend but no Rust bridge (browser / Capacitor shell) → unavailable.
export const ShellUnavailable: Story = {
  args: { providerId: "ocrs", bridge: null },
}
