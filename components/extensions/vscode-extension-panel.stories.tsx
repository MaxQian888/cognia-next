import type { Meta, StoryObj } from "@storybook/nextjs"

import { VscodeExtensionPanel } from "./vscode-extension-panel"
import { __resetWebviewBridgeForTesting, addWebview } from "@/lib/plugin/vscode-shim/webview-bridge"

const EXT = "story.sample-ext"

// The extension rail's tabs: a webview panel and a view. Without a running
// extension host the frames stay in their loading state, which is what this
// shows besides the tab strip.
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

const OPTIONS = {
  enableScripts: false,
  enableForms: false,
  enableCommandUris: false,
  retainContextWhenHidden: false,
}

export const WithWebviews: Story = {
  beforeEach: () => {
    __resetWebviewBridgeForTesting()
    addWebview(
      {
        handle: "story-panel",
        pluginId: EXT,
        kind: "panel",
        viewType: "sample.preview",
        title: "Preview",
        html: "<h2>Hello from a VS Code webview</h2>",
        options: OPTIONS,
      },
      { select: true }
    )
    addWebview(
      {
        handle: "story-view",
        pluginId: EXT,
        kind: "view",
        viewType: "sample.view",
        title: "Explorer",
        description: "2 items",
        badge: { value: 2, tooltip: "Two items" },
        html: "",
        options: OPTIONS,
        token: "wvv:story",
      },
      { select: false }
    )
    return () => __resetWebviewBridgeForTesting()
  },
}

// No webviews: the empty-state notice.
export const Empty: Story = {
  beforeEach: () => {
    __resetWebviewBridgeForTesting()
  },
}
