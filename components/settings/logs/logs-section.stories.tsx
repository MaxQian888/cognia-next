import type { Meta, StoryObj } from "@storybook/nextjs"

import { LogsSection } from "./logs-section"

// Settings → Observability → Logs as a master/detail shell: pipeline overview,
// levels, filtering & redaction, transports, telemetry consent, and local
// retention. Native (Rust) controls are Tauri-gated, so the browser preview
// renders the web branch — everything else is fully interactive here, writing
// into the same `useLogSettingsDraft` draft the save bar commits.
const meta = {
  title: "Settings/Logs/LogsSection",
  component: LogsSection,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
} satisfies Meta<typeof LogsSection>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The active panel is read from the URL, and Storybook has no App Router, so
 * `router.replace` on nav click is a no-op here — clicking the rail will not
 * switch panels in the preview. Each panel gets its own story with the query
 * stubbed instead.
 */
const atPanel = (logsPanel: string, width = 1024) => ({
  parameters: { nextjs: { appDirectory: true, navigation: { query: { logsPanel } } } },
  decorators: [
    (Story: () => React.ReactElement) => (
      <div className="h-[760px] p-4" style={{ width }}>
        <Story />
      </div>
    ),
  ],
})

/** The real settings width — nav rail beside a comfortable detail pane. */
export const Default: Story = atPanel("overview")

export const Levels: Story = atPanel("levels")

export const FilteringAndRedaction: Story = atPanel("filters")

export const Transports: Story = atPanel("transports")

export const Telemetry: Story = atPanel("telemetry")

export const Retention: Story = atPanel("retention")

/**
 * The transports panel below the `@md/settings-stack` breakpoint, where every
 * two-column detail grid collapses. This is the case a viewport breakpoint gets
 * wrong: the window is wide, the pane is not.
 */
export const NarrowPane: Story = atPanel("transports", 640)

/** Below `md` the rail moves into a Sheet behind the "Sections" trigger. */
export const Mobile: Story = atPanel("levels", 420)
