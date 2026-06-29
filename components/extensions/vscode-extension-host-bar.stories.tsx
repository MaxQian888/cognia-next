import type { FC } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"

import {
  VscodeExtensionHostBar,
  type VscodeExtensionHostBarProps,
} from "./vscode-extension-host-bar"
import {
  createWebviewPanel,
  disposeWebviewPanelsByExtension,
} from "@/lib/plugin/vscode-shim/webview-bridge"

const EXT = "story.host-bar-ext"

// The component's props are entirely optional behind a `= {}` default param,
// which makes Storybook infer `never` story args; alias it as a typed FC so the
// Meta picks up the real prop type.
const HostBar: FC<VscodeExtensionHostBarProps> = VscodeExtensionHostBar

// Visibility-gated mounter for the extension webview panels: renders nothing
// when no webview is active, and the panel host once one registers.
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
    disposeWebviewPanelsByExtension(EXT)
    createWebviewPanel({
      extensionId: EXT,
      viewType: "host.view",
      title: "Extension Panel",
      type: "view",
      hostSlot: "sidebar.right",
      options: { enableScripts: true },
      initialHtml: "<p style='font-family:sans-serif'>Webview content</p>",
    })
  },
}

// No active webview → the bar renders nothing.
export const Hidden: Story = {
  beforeEach: () => {
    disposeWebviewPanelsByExtension(EXT)
  },
  render: () => (
    <div className="p-3 text-xs text-muted-foreground">
      renders nothing → <VscodeExtensionHostBar />
    </div>
  ),
}
