import type { Meta, StoryObj } from "@storybook/nextjs"

import { VscodeExtensionPanel } from "./vscode-extension-panel"
import {
  createWebviewPanel,
  disposeWebviewPanelsByExtension,
} from "@/lib/plugin/vscode-shim/webview-bridge"

const EXT = "story.sample-ext"

// Host for VS Code extension WebviewViews. Renders an iframe per registered
// panel, or an empty-state notice when no extension has registered a webview.
const meta = {
  title: "Extensions/VscodeExtensionPanel",
  component: VscodeExtensionPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[420px] w-[360px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VscodeExtensionPanel>

export default meta
type Story = StoryObj<typeof meta>

export const WithWebview: Story = {
  beforeEach: () => {
    disposeWebviewPanelsByExtension(EXT)
    createWebviewPanel({
      extensionId: EXT,
      viewType: "sample.view",
      title: "Sample Extension",
      type: "view",
      hostSlot: "sidebar.right",
      options: { enableScripts: true },
      initialHtml: "<h2 style='font-family:sans-serif'>Hello from a VS Code webview</h2>",
    })
    return () => disposeWebviewPanelsByExtension(EXT)
  },
}

// No registered webviews → the empty-state notice.
export const Empty: Story = {
  beforeEach: () => {
    disposeWebviewPanelsByExtension(EXT)
  },
}
