import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EditableSettingRow } from "./editable-setting-row"

const meta = {
  title: "Agent/Workspace/Settings/EditableSettingRow",
  component: EditableSettingRow,
  args: {
    label: "Auto-shutdown",
    hint: "Shut down idle teammates when all tasks complete.",
    value: true,
    onCommit: fn(),
    render: ({ value, setValue }) => (
      <Switch checked={Boolean(value)} onCheckedChange={(next) => setValue(next)} />
    ),
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EditableSettingRow>

export default meta
type Story = StoryObj<typeof meta>

// Debounced switch row; toggling pings the global save indicator.
export const SwitchRow: Story = {}

export const SelectRow: Story = {
  args: {
    label: "Execution mode",
    hint: "How the lead distributes work.",
    value: "coordinated",
    render: ({ value, setValue }) => (
      <Select value={String(value)} onValueChange={(next) => setValue(next)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="coordinated">Coordinated</SelectItem>
          <SelectItem value="autonomous">Autonomous</SelectItem>
          <SelectItem value="delegate">Delegate</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
}

// confirmBefore opens a ConfirmActionDialog when the predicate matches.
export const WithConfirm: Story = {
  args: {
    label: "Bypass permissions",
    value: false,
    confirmBefore: {
      title: "Enable bypass permissions?",
      description: "Teammates skip per-tool approval for this run.",
      confirmLabel: "Enable",
      cancelLabel: "Cancel",
      predicate: (next) => next === true,
    },
    render: ({ value, setValue }) => (
      <Switch checked={Boolean(value)} onCheckedChange={(next) => setValue(next)} />
    ),
  },
}
