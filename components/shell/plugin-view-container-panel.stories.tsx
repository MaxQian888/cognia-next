import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginViewContainerPanel } from "./plugin-view-container-panel"
import {
  registerViewContainer,
  __resetViewContainersForTesting,
} from "@/lib/plugin/registries/view-container-registry"

// Middle-column panel for a plugin-contributed view container. Reads the
// view-container / view / webview registries via useSyncExternalStore. With
// nothing registered for the id it shows the "unavailable" state; registering a
// container (with no views) shows the header + empty body.
const meta = {
  title: "Shell/PluginViewContainerPanel",
  component: PluginViewContainerPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[360px] border rounded-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginViewContainerPanel>

export default meta
type Story = StoryObj<typeof meta>

// Registered container, no views → header + empty body.
export const RegisteredEmpty: Story = {
  args: { containerId: "demo-plugin:files" },
  beforeEach: () => {
    __resetViewContainersForTesting()
    registerViewContainer(
      { id: "files", title: "Project Files", icon: "FolderTree", location: "panel" },
      { pluginId: "demo-plugin" }
    )
    return () => __resetViewContainersForTesting()
  },
}

// No matching registration → the unavailable state.
export const Unavailable: Story = {
  args: { containerId: "missing-plugin:nope" },
  beforeEach: () => {
    __resetViewContainersForTesting()
  },
}
