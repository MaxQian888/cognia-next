import type { Meta, StoryObj } from "@storybook/nextjs"

import { ExternalBridgeSection } from "./external-bridge-section"

// External Bridge (MCP server) settings as a master/detail shell: server &
// token, permission scopes, wiki maintenance, client setup, and the Dexie-backed
// audit log. The server control is Tauri-gated, so the browser preview renders
// the web branch — scopes, setup snippets, and the (empty) audit log are still
// fully interactive here.
const meta = {
  title: "Settings/ExternalBridge/ExternalBridgeSection",
  component: ExternalBridgeSection,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
} satisfies Meta<typeof ExternalBridgeSection>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The active panel is read from the URL, and Storybook has no App Router, so
 * `router.replace` on nav click is a no-op here — clicking the rail will not
 * switch panels in the preview. Each panel gets its own story with the query
 * stubbed instead.
 */
const atPanel = (bridgePanel: string, width = 960) => ({
  parameters: { nextjs: { appDirectory: true, navigation: { query: { bridgePanel } } } },
  decorators: [
    (Story: () => React.ReactElement) => (
      <div className="h-[720px] p-4" style={{ width }}>
        <Story />
      </div>
    ),
  ],
})

/** The real settings width — nav rail beside a comfortable detail pane. */
export const Default: Story = atPanel("server")

export const Scopes: Story = atPanel("scopes")

export const ClientSetup: Story = atPanel("setup")

export const AuditLog: Story = atPanel("audit")

/**
 * The setup panel's snippet controls below the `@lg/bridge-pane` breakpoint,
 * where the client picker and copy button stack instead of sitting in a row.
 * This is the case a viewport breakpoint gets wrong: the window is wide, the
 * pane is not.
 */
export const NarrowPane: Story = atPanel("setup", 620)
