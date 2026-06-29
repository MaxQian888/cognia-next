import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import {
  BotIcon,
  CalendarIcon,
  FlaskConicalIcon,
  InboxIcon,
  LayoutDashboardIcon,
  TerminalIcon,
  WorkflowIcon,
} from "lucide-react"

import { CustomizerLists, type CustomizerItem } from "./customizer-list"

// Pure three-bucket layout editor (Pinned drag-reorderable / More / Hidden)
// shared by the nav-rail customizer and the discover customizer. All data +
// handlers come from props.
const item = (id: string, label: string, Icon: CustomizerItem["Icon"]): CustomizerItem => ({
  id,
  label,
  Icon,
})

const LABELS = {
  restoreDefaults: "Restore defaults",
  pinned: "Pinned",
  dragHint: "Drag to reorder",
  pinnedEmpty: "Nothing pinned",
  more: "More",
  moreEmpty: "Nothing in More",
  hidden: "Hidden",
  hiddenEmpty: "Nothing hidden",
  moveToMore: "Move to More",
  hideItem: "Hide",
  pin: "Pin",
  showItem: "Show",
}

const meta = {
  title: "Shell/CustomizerLists",
  component: CustomizerLists,
  parameters: { layout: "padded" },
  args: {
    testIdPrefix: "story-customizer",
    isDefault: false,
    labels: LABELS,
    pinned: [
      item("inbox", "Inbox", InboxIcon),
      item("dashboard", "Dashboard", LayoutDashboardIcon),
      item("workflows", "Workflows", WorkflowIcon),
    ],
    overflow: [item("terminal", "Terminal", TerminalIcon), item("agents", "Agents", BotIcon)],
    hidden: [item("eval", "Eval", FlaskConicalIcon), item("calendar", "Calendar", CalendarIcon)],
    onReorderPinned: fn(),
    onPin: fn(),
    onUnpin: fn(),
    onHide: fn(),
    onShow: fn(),
    onReset: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CustomizerLists>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

// At factory default → the "Restore defaults" button is disabled.
export const IsDefault: Story = {
  args: { isDefault: true, overflow: [], hidden: [] },
}

export const AllEmpty: Story = {
  args: { pinned: [], overflow: [], hidden: [], isDefault: true },
}
