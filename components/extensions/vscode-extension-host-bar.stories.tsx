import type { FC } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"

import {
  VscodeExtensionHostBar,
  type VscodeExtensionHostBarProps,
} from "./vscode-extension-host-bar"
import { __resetWebviewBridgeForTesting, addWebview } from "@/lib/plugin/vscode-shim/webview-bridge"

// The component's props are entirely optional behind a `= {}` default param,
// which makes Storybook infer `never` story args; alias it as a typed FC so the
// Meta picks up the real prop type.
const HostBar: FC<VscodeExtensionHostBarProps> = VscodeExtensionHostBar

// The extension rail: nothing until an extension shows a webview, then its tabs.
const meta = {
  title: "Extensions/VscodeExtensionHostBar",
  component: HostBar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[420px] w-[360px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HostBar>

export default meta
type Story = StoryObj<typeof meta>

export const WithWebview: Story = {
  beforeEach: () => {
    __resetWebviewBridgeForTesting()
    addWebview(
      {
        handle: "story-host-bar",
        pluginId: "story.host-bar-ext",
        kind: "panel",
        viewType: "sample.panel",
        title: "Sample Extension",
        html: "<h2>Hello from a VS Code webview</h2>",
        options: {
          enableScripts: false,
          enableForms: false,
          enableCommandUris: false,
          retainContextWhenHidden: false,
        },
      },
      { select: true }
    )
    return () => __resetWebviewBridgeForTesting()
  },
}

// No webviews: the bar renders nothing.
export const Empty: Story = {
  beforeEach: () => {
    __resetWebviewBridgeForTesting()
  },
}
