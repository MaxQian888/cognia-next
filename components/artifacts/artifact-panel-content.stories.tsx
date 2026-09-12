import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactPanelContent } from "./artifact-panel-content"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import { makeArtifact } from "@/lib/storybook/fixtures/artifacts"

const artifact = makeArtifact()

/**
 * A previewable artifact, for the surfaces that only exist once something is
 * actually rendered — the preview tab, and the element picker on it.
 */
const pageArtifact = makeArtifact({
  id: "art_page",
  type: "html",
  title: "pricing.html",
  language: "html",
  content: [
    "<main>",
    '  <section class="hero">',
    "    <h1>Simple pricing</h1>",
    "    <p>Start free. Upgrade when your team grows.</p>",
    '    <button id="cta" class="primary">Get started</button>',
    "  </section>",
    '  <section class="tiers">',
    '    <article class="tier"><h2>Free</h2><p>$0</p></article>',
    '    <article class="tier"><h2>Team</h2><p>$20</p></article>',
    "  </section>",
    "</main>",
  ].join("\n"),
})

function seed(active: typeof artifact) {
  resetStore(useArtifactStore)
  seedStore(useChatStore, { activeSessionId: active.sessionId })
  seedStore(useArtifactStore, {
    artifacts: { [active.id]: active },
    activeArtifactIdBySession: { [active.sessionId]: active.id },
    panelOpen: true,
    panelView: "artifact",
  })
}

function seedActiveArtifact() {
  seed(artifact)
}

// The shared body of the artifacts surface (used by both the Sheet and the
// docked panel). With an active artifact it shows the header + code view; with
// none it falls back to the recent-artifacts list.
const meta = {
  title: "Artifacts/ArtifactPanelContent",
  component: ArtifactPanelContent,
  args: { panelMode: "desktop" },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-[520px] flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactPanelContent>

export default meta
type Story = StoryObj<typeof meta>

export const WithArtifact: Story = {
  beforeEach: () => seedActiveArtifact(),
}

export const EmptyRecentList: Story = {
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
}

/**
 * The element picker's surface. Switch to the Preview tab and press "Select
 * element": hovering the rendered page highlights the node under the pointer
 * and names it, and clicking stages it for the next message.
 *
 * Preview-only, like every story here — the behaviour is pinned by
 * `artifact-panel-content.split.test.tsx` and
 * `lib/artifacts/runtime/element-pick.test.ts`.
 */
export const PreviewableForElementPicking: Story = {
  beforeEach: () => seed(pageArtifact),
}
