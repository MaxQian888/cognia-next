import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"

import { SettingsTab } from "./settings-tab"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { makeWorkflow } from "@/lib/storybook/fixtures/mobile-workflow"

// Workflow-level settings surfaced in the editor's right sidebar. It reads/edits
// the workflow envelope (settings / variables / credentials) through an
// `EditorStore`. We build a real store via `createEditorStore` and seed it with
// a small workflow. `useMemo` gives each render its own store instance.
function StoreHost({ variables }: { variables?: Record<string, string> }) {
  const store = React.useMemo(
    () =>
      createEditorStore(
        makeWorkflow({
          id: "wf_settings_demo",
          name: "Settings demo",
          variables,
        })
      ),
    [variables]
  )
  return (
    <div className="h-[640px] w-[360px] border-l">
      <SettingsTab useStore={store} />
    </div>
  )
}

// Module-scope store satisfies the meta's required `useStore` arg; the stories
// below render with their own fresh stores.
const baseStore = createEditorStore(makeWorkflow({ id: "wf_settings_base", name: "Settings demo" }))

const meta = {
  title: "Workflow/Editor/RightSidebar/SettingsTab",
  component: SettingsTab,
  parameters: { layout: "fullscreen" },
  args: { useStore: baseStore },
} satisfies Meta<typeof SettingsTab>

export default meta
type Story = StoryObj<typeof meta>

// Default settings (error policy, timeout, concurrency, retry defaults).
export const Default: Story = {
  render: () => <StoreHost />,
}

// A workflow that already declares some `$vars`.
export const WithVariables: Story = {
  render: () => <StoreHost variables={{ region: "us-east-1", channel: "#alerts" }} />,
}
