import type { Meta, StoryObj } from "@storybook/nextjs"

import A2UIPage from "@/app/a2ui/page"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { Character } from "@cognia/agent-config-types"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"

// The `/a2ui` hub. Storybook only globs `components/**`, so the route component
// is imported here to give the redesigned page a visual preview that does not
// need the app's first-run account gate.
//
// Saved apps live in localStorage (`a2ui-app-instances`) behind a lazily-filled
// module cache, so the seed has to be written before the first render.

const APP_INSTANCES_KEY = "a2ui-app-instances"
const GENERATION_PREFS_KEY = "a2ui-generation-preferences"

// The composer's agent chip reads characters through the data adapter, which
// `app/layout.tsx` mounts in production but Storybook's preview does not.
const STORY_CHARACTERS = [
  { id: "char_builder", name: "App Builder", isBuiltIn: true },
  { id: "char_analyst", name: "Data Analyst", isBuiltIn: true },
] as Character[]

const storyAdapter: DataAdapter = {
  useCharacters: () => STORY_CHARACTERS,
  useCharacter: (id) => STORY_CHARACTERS.find((c) => c.id === id),
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

function makeApp(over: Partial<A2UIAppInstance> = {}): A2UIAppInstance {
  return {
    id: "story-surface",
    templateId: "calculator",
    name: "Expense Tracker",
    description: "Log spending and watch the running total.",
    category: "productivity",
    tags: ["finance", "tracker"],
    createdAt: Date.UTC(2026, 6, 1),
    lastModified: Date.UTC(2026, 7, 18),
    ...over,
  }
}

function seedApps(apps: A2UIAppInstance[]) {
  window.localStorage.setItem(APP_INSTANCES_KEY, JSON.stringify(apps))
  window.localStorage.removeItem(GENERATION_PREFS_KEY)
  resetStore(useA2UIStore)
  seedStore(useA2UIStore, {
    surfaces: Object.fromEntries(
      apps.map((app) => [app.id, makeSurfaceState({ id: app.id, title: app.name })])
    ),
  })
}

const meta = {
  title: "A2UI/Hub",
  component: A2UIPage,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <DataAdapterProvider adapter={storyAdapter}>
        <div className="flex h-[900px] w-full flex-col bg-background">
          <Story />
        </div>
      </DataAdapterProvider>
    ),
  ],
} satisfies Meta<typeof A2UIPage>

export default meta
type Story = StoryObj<typeof meta>

/** First run: the composer is the only thing with weight on the page. */
export const Empty: Story = {
  beforeEach: () => {
    seedApps([])
  },
}

/** Enough rows to exercise the sticky library toolbar and back-to-top. */
export const LongLibrary: Story = {
  beforeEach: () => {
    const names = [
      "Expense Tracker",
      "Pomodoro Timer",
      "Unit Converter",
      "Habit Grid",
      "BMI Calculator",
      "Todo List",
      "Standup Notes",
      "Invoice Builder",
      "Reading Log",
      "Water Intake",
      "Sprint Board",
      "Recipe Scaler",
    ]
    seedApps(
      names.map((name, index) =>
        makeApp({
          id: index === 0 ? "story-surface" : `story-surface-${index}`,
          name,
          category: index % 2 === 0 ? "productivity" : "utility",
          tags: index % 3 === 0 ? ["daily"] : ["tools", "math"],
          lastModified: Date.UTC(2026, 7, 20 - index),
          isFavorite: index === 1,
        })
      )
    )
  },
}

export const WithApps: Story = {
  beforeEach: () => {
    seedApps([
      makeApp(),
      makeApp({
        id: "story-surface-2",
        name: "Pomodoro Timer",
        description: "25/5 focus cycles with a chime.",
        category: "utility",
        tags: ["focus"],
        lastModified: Date.UTC(2026, 7, 12),
        isFavorite: true,
      }),
      makeApp({
        id: "story-surface-3",
        name: "Unit Converter",
        description: "Length, mass and temperature.",
        category: "utility",
        tags: ["math", "tools"],
        lastModified: Date.UTC(2026, 7, 3),
      }),
    ])
  },
}
