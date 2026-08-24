import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import { fn } from "storybook/test"

import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { ComposerSkinId } from "@/lib/chat/composer-skin"
import type { ChatSession } from "@cognia/agent-config-types"

// The full chat composer: textarea + toolbar (model / permission / effort /
// attachments / skills / voice) + the slash-command & @mention popovers. It is
// fully props-driven and renders against a mock data adapter + seeded chat
// store, exactly as it does inside ChatPane.
const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withChrome = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <div className="mx-auto w-full max-w-3xl p-4">
      <Story />
    </div>
  </DataAdapterProvider>
)

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "demo-session",
    title: "Demo",
    characterId: "claude",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    workingDir: "/repo",
    ...over,
  }) as ChatSession

const meta = {
  title: "Chat/Composer",
  component: Composer,
  parameters: { layout: "fullscreen" },
  decorators: [withChrome],
  args: {
    session: session(),
    onStartNewSession: fn(),
    onOpenSettings: fn(),
    onSend: fn(),
    onStop: fn(),
  },
  beforeEach: () => {
    resetStore(useChatStore)
    useChatStore.getState().setActiveSession("demo-session")
  },
} satisfies Meta<typeof Composer>

export default meta
type Story = StoryObj<typeof meta>

/** Idle, empty composer with the full toolbar. */
export const Default: Story = {}

/** A custom placeholder hint. */
export const CustomPlaceholder: Story = {
  args: { placeholder: "Ask the team anything…" },
}

/** Disabled (e.g. before an API key is configured). */
export const Disabled: Story = {
  args: { disabled: true },
}

// ── Skins ──────────────────────────────────────────────────────────────────
//
// The same composer under each arrangement. Every one reaches the identical
// roster of controls; they differ in what sits on the row and what folds behind
// the "⋯" on the status line. `Classic` is the default and is what the app has
// always rendered — it is here so the others can be compared against it.
function withSkin(skin: ComposerSkinId) {
  return () => {
    resetStore(useChatStore)
    useChatStore.getState().setActiveSession("demo-session")
    seedStore(useSettingsStore, {
      settings: { id: "singleton", composerBehavior: { skin } },
    } as never)
  }
}

/** Today's composer. The default, and preserved byte-for-byte. */
export const SkinClassic: Story = { beforeEach: withSkin("classic") }

/** Roomy and rounded, status row inside the box under the text. */
export const SkinAiry: Story = { beforeEach: withSkin("airy") }

/** Tight and squared, with a monospace status line inside the box. */
export const SkinDense: Story = { beforeEach: withSkin("dense") }

/** Every control spelled out inline, cost and context on their own rail. */
export const SkinDetailed: Story = { beforeEach: withSkin("full") }

/** Just the text and the model; everything else folds behind "⋯". */
export const SkinMinimal: Story = { beforeEach: withSkin("focus") }

/** A tuned skin: square corners and a monospace input on top of `dense`. */
export const SkinCustomised: Story = {
  beforeEach: () => {
    resetStore(useChatStore)
    useChatStore.getState().setActiveSession("demo-session")
    seedStore(useSettingsStore, {
      settings: {
        id: "singleton",
        composerBehavior: {
          skin: "airy",
          skinOverrides: { radiusPx: 4, padXPx: 18, mono: true, sendShape: "rounded" },
        },
      },
    } as never)
  },
}
