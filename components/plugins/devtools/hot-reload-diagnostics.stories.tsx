import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { HotReloadDiagnostics } from "./hot-reload-diagnostics"
import {
  useHotReloadHistoryStore,
  type HotReloadEntry,
} from "@/stores/plugin-runtime/hot-reload-history-store"

// Hot-reload activity panel from the plugin DevTools pane. The panel is a pure
// read surface over `hot-reload-history-store` (the bridge-events hook owns the
// subscription), so each story seeds that Zustand store directly before render
// — exactly the way the co-located test drives it — to paint the meaningful
// state matrix: empty / healthy success run / degraded (failures + in-progress)
// / a realistic mixed session.
//
// Timestamps are pinned to fixed wall-clock seconds so the HH:MM:SS column is
// stable across runs (the row label format is local time, not relative).

// A fixed base time keeps the rendered HH:MM:SS column deterministic. The store
// dedupes same-plugin same-kind events within 500ms, so entries are spaced well
// apart.
const BASE = new Date(2026, 5, 25, 14, 30, 0).getTime()
const at = (offsetSeconds: number) => BASE + offsetSeconds * 1000

/** Reset the session store and replay a fixed set of events newest-last. */
function seed(entries: HotReloadEntry[]) {
  const store = useHotReloadHistoryStore.getState()
  store.clear()
  // record() prepends, so replay oldest-first to land newest at the top.
  for (const entry of entries) store.record(entry)
}

/** Seed the store before paint, then render the panel inside a card-width box. */
function Seeded({ entries }: { entries: HotReloadEntry[] }) {
  // useState initializer runs once, before the first paint — same timing the
  // bridge-events hook would have populated the store by.
  React.useState(() => {
    seed(entries)
    return null
  })
  return <HotReloadDiagnostics />
}

const meta = {
  title: "Plugins/DevTools/HotReloadDiagnostics",
  component: HotReloadDiagnostics,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HotReloadDiagnostics>

export default meta
type Story = StoryObj<typeof meta>

// Default = empty session: no events recorded yet, so the panel shows the
// "run `cognia plugin dev`" empty hint and hides the Clear button.
export const Empty: Story = {
  render: () => <Seeded entries={[]} />,
}

// Healthy run: a clean install followed by several successful hot-reloads, the
// happy path a developer sees during a `cognia plugin dev` watch loop.
export const Healthy: Story = {
  render: () => (
    <Seeded
      entries={[
        {
          pluginId: "com.acme.clipboard",
          source: "cli-bridge",
          kind: "install",
          status: "success",
          timestamp: at(0),
        },
        {
          pluginId: "com.acme.clipboard",
          source: "plugin-hot-reload",
          kind: "hot-reload",
          status: "success",
          timestamp: at(12),
        },
        {
          pluginId: "com.acme.clipboard",
          source: "plugin-hot-reload",
          kind: "hot-reload",
          status: "success",
          timestamp: at(31),
        },
      ]}
    />
  ),
}

// Degraded run: a failed hot-reload (build error) plus an in-progress reload
// still spinning — the diagnostic state the panel exists to surface.
export const Degraded: Story = {
  render: () => (
    <Seeded
      entries={[
        {
          pluginId: "com.acme.web-tools",
          source: "cli-bridge",
          kind: "install",
          status: "success",
          timestamp: at(0),
        },
        {
          pluginId: "com.acme.web-tools",
          source: "plugin-hot-reload",
          kind: "hot-reload",
          status: "failed",
          timestamp: at(18),
          note: "manifest watcher restarted",
        },
        {
          pluginId: "com.acme.web-tools",
          source: "plugin-hot-reload",
          kind: "hot-reload",
          status: "in-progress",
          timestamp: at(40),
        },
      ]}
    />
  ),
}

// A realistic mixed session across several plugins: installs, a hot-reload, an
// uninstall, a failure, and an in-progress reload — every row variant the panel
// renders, stacked the way a real dev session accumulates them.
export const MixedSession: Story = {
  render: () => (
    <Seeded
      entries={[
        {
          pluginId: "com.acme.clipboard",
          source: "cli-bridge",
          kind: "install",
          status: "success",
          timestamp: at(0),
        },
        {
          pluginId: "com.acme.clipboard",
          source: "plugin-hot-reload",
          kind: "hot-reload",
          status: "success",
          timestamp: at(15),
        },
        {
          pluginId: "com.acme.screenshot",
          source: "cli-bridge",
          kind: "install",
          status: "failed",
          timestamp: at(28),
        },
        {
          pluginId: "com.acme.ocr",
          source: "cli-bridge",
          kind: "uninstall",
          status: "success",
          timestamp: at(44),
        },
        {
          pluginId: "com.acme.web-tools",
          source: "plugin-hot-reload",
          kind: "hot-reload",
          status: "in-progress",
          timestamp: at(60),
        },
      ]}
    />
  ),
}
