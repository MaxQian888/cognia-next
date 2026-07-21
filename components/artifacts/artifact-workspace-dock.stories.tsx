import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactWorkspaceDock } from "./artifact-workspace-dock"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { makeArtifact } from "@/lib/storybook/fixtures/artifacts"

const artifact = makeArtifact()

function ChatPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center bg-muted/20 text-sm text-muted-foreground">
      Chat workspace (children)
    </div>
  )
}

// Wraps the chat workspace so a docked, resizable artifacts panel can sit in the
// right rail on desktop. On tablet/mobile it renders the children plus the
// Sheet fallback. The dock auto-expands when an artifact becomes active.
const meta = {
  title: "Artifacts/ArtifactWorkspaceDock",
  component: ArtifactWorkspaceDock,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-full">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    resetStore(useArtifactStore)
    resetStore(useArtifactDockLayoutStore)
    seedStore(useArtifactStore, {
      artifacts: { [artifact.id]: artifact },
      activeArtifactId: artifact.id,
    })
    seedStore(useArtifactDockLayoutStore, { dockCollapsed: false })
  },
} satisfies Meta<typeof ArtifactWorkspaceDock>

export default meta
type Story = StoryObj<typeof meta>

export const WithDock: Story = {
  args: { children: <ChatPlaceholder /> },
}

// No active artifact. The dock keeps the same workbench chrome and falls back to
// the session surface (artifact history / browser / workspace) instead of
// swapping to the legacy top-tab dock.
export const SessionSurface: Story = {
  args: { children: <ChatPlaceholder /> },
  beforeEach: () => {
    seedStore(useArtifactStore, { artifacts: {}, activeArtifactId: null })
  },
}

// The embedded browser is a session panel, so it renders inside the same
// activity rail rather than replacing the dock chrome.
export const BrowserSurface: Story = {
  args: { children: <ChatPlaceholder /> },
  beforeEach: () => {
    seedStore(useArtifactDockLayoutStore, {
      revealIntent: { panelId: "browser", mode: "wide" },
      dockCollapsed: false,
    })
  },
}
