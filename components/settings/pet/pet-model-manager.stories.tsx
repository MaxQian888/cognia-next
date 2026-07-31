import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetModelManager } from "./pet-model-manager"
import { clearDb } from "@/lib/storybook/seed-db"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

// Lists installed Live2D models live via `useLiveQuery(listPetModels)`. The
// Storybook browser opens a real, empty IndexedDB, so the default renders the
// "no models" empty state plus the import / folder / sample-download controls.
// `settings` + `onPatch` are props; persistence helpers are module-level.
const meta = {
  title: "Settings/Pet/PetModelManager",
  component: PetModelManager,
  parameters: { layout: "padded" },
  args: {
    settings: DEFAULT_PET_SETTINGS,
    onPatch: fn(),
  },
  beforeEach: async () => {
    await clearDb()
  },
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetModelManager>

export default meta
type Story = StoryObj<typeof meta>

// Empty IndexedDB → "no models" + import controls + sample catalog.
export const Default: Story = {}
