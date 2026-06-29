import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UITable } from "./a2ui-table"
import type { A2UITableColumn, A2UITableComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const COLUMNS: A2UITableColumn[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "role", header: "Role" },
  { key: "commits", header: "Commits", align: "right", type: "number", sortable: true },
  { key: "active", header: "Active", align: "center", type: "boolean" },
]

const ROWS: Record<string, unknown>[] = [
  { id: "1", name: "Ada Lovelace", role: "Maintainer", commits: 1284, active: true },
  { id: "2", name: "Alan Turing", role: "Reviewer", commits: 932, active: true },
  { id: "3", name: "Grace Hopper", role: "Contributor", commits: 477, active: false },
  { id: "4", name: "Linus Pauling", role: "Contributor", commits: 218, active: true },
  { id: "5", name: "Katherine Johnson", role: "Reviewer", commits: 1502, active: true },
]

const MANY_ROWS: Record<string, unknown>[] = Array.from({ length: 28 }, (_, i) => ({
  id: String(i + 1),
  name: `Contributor ${i + 1}`,
  role: i % 3 === 0 ? "Maintainer" : "Contributor",
  commits: Math.round(2000 - i * 53),
  active: i % 4 !== 0,
}))

const table = (over: Partial<A2UITableComponent> = {}): A2UITableComponent => ({
  id: "table",
  component: "Table",
  columns: COLUMNS,
  data: ROWS,
  title: "Repository contributors",
  rowKey: "id",
  ...over,
})

const meta = {
  title: "A2UI/Data/Table",
  component: A2UITable,
  decorators: [(Story) => <div className="w-[640px] max-w-full">{<Story />}</div>],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UITable>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: makeA2UIProps(table()) }

export const Sortable: Story = {
  args: makeA2UIProps(
    table({ sortAction: "sort", description: "Click a sortable header to reorder." })
  ),
}

export const Selectable: Story = {
  args: makeA2UIProps(table({ selectable: true, selectAction: "select" })),
}

export const Paginated: Story = {
  args: makeA2UIProps(
    table({ data: MANY_ROWS, pagination: true, pageSize: 8, pageChangeAction: "page" })
  ),
}

export const Empty: Story = {
  args: makeA2UIProps(table({ data: [], emptyMessage: "No contributors found." })),
}
