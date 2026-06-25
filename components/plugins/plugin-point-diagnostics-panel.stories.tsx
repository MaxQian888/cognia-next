import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { PluginPointDiagnosticsPanel } from "./plugin-point-diagnostics-panel"
import type { PluginPointDiagnostic } from "@/lib/plugin/contracts/plugin-points"

// Plugin-point runtime diagnostics panel from the Plugins → Audit settings.
// It reads from the live diagnostics store via injectable `getDiagnostics` /
// `subscribe` props (the same seam the unit test uses), so these stories pass a
// static snapshot to render the healthy (empty) and issues states without the
// real store. The severity filter and clear-all dialog stay interactive.

const diagnostic = (over: Partial<PluginPointDiagnostic> = {}): PluginPointDiagnostic => ({
  code: "plugin.point.unknown",
  severity: "warning",
  message: "Contribution targets an unknown plugin point.",
  pointKind: "hook",
  pointId: "onLoad",
  ...over,
})

// A frozen subscribe that never fires — useSyncExternalStore just reads the
// snapshot once, which is all a static story needs.
const staticSubscribe = () => () => {}

const makeStore = (snapshot: Record<string, PluginPointDiagnostic[]>) => ({
  getDiagnostics: () => snapshot,
  subscribe: staticSubscribe,
  clearForPlugin: fn(),
  clearAll: fn(),
})

const meta = {
  title: "Plugins/PluginPointDiagnosticsPanel",
  component: PluginPointDiagnosticsPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[720px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginPointDiagnosticsPanel>

export default meta
// `PluginPointDiagnosticsPanel`'s props are all optional (its sole parameter
// defaults to `{}`), which makes `StoryObj<typeof meta>` collapse the inferred
// `args` to `never`. Deriving the story type from the component directly keeps
// the injectable store props (`getDiagnostics` / `subscribe` / `clear*`)
// available on `args`.
type Story = StoryObj<typeof PluginPointDiagnosticsPanel>

// Healthy: no diagnostics recorded — the empty hint shows, clear-all disabled.
export const Healthy: Story = {
  args: makeStore({}),
}

// A mix of error + warning groups; the errored group expands by default.
export const WithIssues: Story = {
  args: makeStore({
    "com.acme.ocr": [
      diagnostic({
        code: "plugin.dependency.missing",
        severity: "error",
        message: "Required dependency com.acme.runtime is not installed.",
        pointKind: "activation",
        pointId: "enable",
        hint: "Install com.acme.runtime, then re-enable this plugin.",
      }),
      diagnostic({
        code: "plugin.silent-failure",
        severity: "error",
        message: "Hook onLoad threw and was swallowed by the sandbox.",
        pointKind: "hook",
        pointId: "onLoad",
      }),
    ],
    "com.acme.web-tools": [
      diagnostic({
        code: "plugin.point.deprecated",
        severity: "warning",
        message: "ui-slot 'sidebar.legacy' is deprecated; migrate to 'sidebar.primary'.",
        pointKind: "ui-slot",
        pointId: "sidebar.legacy",
        canonicalId: "sidebar.primary",
        hint: "The legacy slot is removed in the next major release.",
      }),
    ],
  }),
}

// Only warnings — every group stays collapsed since none carries an error.
export const WarningsOnly: Story = {
  args: makeStore({
    "com.acme.clipboard": [
      diagnostic({
        code: "plugin.conflict.rejected",
        severity: "warning",
        message: "Tool 'paste' is already owned by com.acme.web-tools (first-wins).",
        pointKind: "runtime",
        pointId: "paste",
      }),
    ],
  }),
}
