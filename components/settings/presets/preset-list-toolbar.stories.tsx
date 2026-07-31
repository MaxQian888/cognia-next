import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"
import { PlusIcon, StarIcon, Trash2Icon } from "lucide-react"

import { PresetListToolbar } from "./preset-list-toolbar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// Search + filter + bulk-action toolbar for the preset list. Pure props; the
// bottom bulk bar appears when `selectionCount > 0`. Stories wire local state
// so the search box is interactive.
function Harness({ selectionCount }: { selectionCount?: number }) {
  const [search, setSearch] = useState("")
  return (
    <PresetListToolbar
      searchValue={search}
      onSearchChange={setSearch}
      filterChips={
        <>
          <Badge variant="secondary">Favorites</Badge>
          <Badge variant="outline">Coding</Badge>
        </>
      }
      rightActions={
        <Button size="sm">
          <PlusIcon className="mr-1 size-3.5" /> New
        </Button>
      }
      selectionCount={selectionCount}
      onClearSelection={fn()}
      bulkActions={
        <>
          <Button size="sm" variant="ghost">
            <StarIcon className="mr-1 size-3.5" /> Favorite
          </Button>
          <Button size="sm" variant="destructive">
            <Trash2Icon className="mr-1 size-3.5" /> Delete
          </Button>
        </>
      }
    />
  )
}

const meta = {
  title: "Settings/Presets/PresetListToolbar",
  component: PresetListToolbar,
  parameters: { layout: "padded" },
  args: { searchValue: "", onSearchChange: fn() },
} satisfies Meta<typeof PresetListToolbar>

export default meta
type Story = StoryObj<typeof meta>

// Search + filter chips + a "New" action, no selection.
export const Default: Story = {
  render: () => <Harness />,
}

// Three rows selected → the fixed bulk action bar shows.
export const WithSelection: Story = {
  render: () => <Harness selectionCount={3} />,
}
