import type { Meta, StoryObj } from "@storybook/nextjs"

import { SchedulerShell } from "./scheduler-shell"

// `SchedulerShell` is a responsive layout container driven by render props. It
// owns its own `SidebarProvider`, and reads only `useBreakpoint` /
// `useResizableLayout` (both browser-safe), so it renders standalone. The actual
// breakpoint depends on the Storybook viewport width.
const meta = {
  title: "Scheduler/SchedulerShell",
  component: SchedulerShell,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[760px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerShell>

export default meta
type Story = StoryObj<typeof meta>

const Sidebar = () => (
  <div className="flex h-full flex-col gap-2 p-3 text-sm">
    <p className="font-semibold">Tasks</p>
    <div className="rounded bg-accent px-2 py-1">Overnight digest</div>
    <div className="rounded px-2 py-1">Weekly report</div>
    <div className="rounded px-2 py-1">Loop poll</div>
  </div>
)

const Header = (
  <div className="flex h-12 shrink-0 items-center border-b px-4 text-sm font-semibold">
    Scheduler
  </div>
)

const Detail = (
  <div className="p-6 text-sm text-muted-foreground">
    Detail / dashboard pane content renders here.
  </div>
)

/** Default three-tier shell with a list pane, header, and detail pane. */
export const Default: Story = {
  args: {
    sidebar: () => <Sidebar />,
    header: Header,
    detail: Detail,
  },
}

/** With the desktop-only right rail (self-gated `xl:flex`). */
export const WithRail: Story = {
  args: {
    sidebar: () => <Sidebar />,
    header: Header,
    detail: Detail,
    rail: (
      <div className="hidden w-64 shrink-0 border-s p-4 text-sm text-muted-foreground xl:flex xl:flex-col">
        Upcoming runs rail
      </div>
    ),
  },
}

/** Mobile push-detail overlay open (visible only at the mobile breakpoint). */
export const MobileDetailOpen: Story = {
  args: {
    sidebar: () => <Sidebar />,
    header: Header,
    detail: Detail,
    isMobileDetailOpen: true,
    mobileDetail: <div className="p-6 text-sm">Full-screen mobile detail overlay content.</div>,
  },
}
