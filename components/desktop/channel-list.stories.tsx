import { useEffect, useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import type { ChatSession, Team } from "@cognia/agent-config-types"
import {
  TitleBarOutletsProvider,
  TitleBarProjectionScope,
  useTitleBarOutletRef,
} from "@/components/shell/title-bar-outlets"
import { getDb } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings"

import { ChannelList } from "./channel-list"

// The merged (expanded) sidebar: the title projects into the window bar, so the
// rail itself carries the shell navigation rows, the search row and the guild
// accordion. `merged` is `headerOutlet !== null`, which means the story has to
// mount a real title-bar outlet and enable the projection scope — the same
// wiring `channel-list.test.tsx` uses.
function StartOutlet() {
  const ref = useTitleBarOutletRef("start")
  return <div ref={ref} className="hidden" />
}

const TEAMS: Team[] = [
  { id: "t-alpha", name: "Alpha", avatarColor: "oklch(0.7 0.15 200)" },
  { id: "t-beta", name: "Beta", avatarColor: "oklch(0.7 0.15 320)" },
  { id: "t-gamma", name: "Gamma", avatarColor: "oklch(0.75 0.16 90)" },
].map((t) => ({
  ...t,
  members: [],
  orchestration: "round_robin",
  createdAt: 0,
  updatedAt: 0,
})) as Team[]

const SESSIONS = [
  "Refactor the sidebar rail",
  "Weekly digest draft",
  "Bug triage",
  "Release notes",
].map(
  (title, i) =>
    ({
      id: `s-${i}`,
      title,
      kind: "direct",
      createdAt: 0,
      updatedAt: 1_000 - i,
    }) as unknown as ChatSession
)

/**
 * Seeds the teams the accordion lists. They come from Dexie via a live query,
 * which works in the browser — so the story writes them once rather than
 * mocking the read.
 */
function SeedTeams({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // `load()` is what the app's boot providers call; without it the settings
    // store stays null here and the sidebar renders every preference — the
    // team order included — at its default.
    void Promise.all([getDb().teams.bulkPut(TEAMS), useSettingsStore.getState().load()])
      .catch(() => undefined)
      .then(() => setReady(true))
  }, [])
  return ready ? <>{children}</> : null
}

const meta = {
  title: "Desktop/ChannelList",
  component: ChannelList,
  parameters: { layout: "fullscreen" },
  args: {
    sessions: SESSIONS,
    activeSessionId: "s-0",
    onSelect: fn(),
    onNewDirect: fn(),
    onNewTeamConversation: fn(),
    onDelete: fn(),
    onRename: fn(),
  },
  decorators: [
    (Story) => (
      <SeedTeams>
        <TitleBarOutletsProvider>
          <StartOutlet />
          <TitleBarProjectionScope enabled>
            <div className="flex h-[640px] w-[280px] border-r">
              <Story />
            </div>
          </TitleBarProjectionScope>
        </TitleBarOutletsProvider>
      </SeedTeams>
    ),
  ],
} satisfies Meta<typeof ChannelList>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The alignment this story exists for: the search field and the three controls
 * beside it take the navigation rows' 32px `rounded-md` box, and the field's
 * icon and placeholder sit on the rows' icon and label columns.
 */
export const Default: Story = {}
