import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { TokenGroup, TOKEN_GROUPS } from "./token-group"
import { DEFAULT_FALLBACKS } from "@/lib/appearance"
import { auditThemeContrast } from "@/lib/appearance/contrast-audit"
import type { ThemeColors } from "@/types/plugin/plugin"

// A collapsible cluster of `ColorTokenRow`s for one role group (Surface,
// Primary, …). Drives a live contrast audit; flagged rows get a chip and the
// group header shows a failure badge. The stories keep local edits in state.
const SURFACE_GROUP = TOKEN_GROUPS[0]

function Harness({ overrides }: { overrides: Partial<ThemeColors> }) {
  const [values, setValues] = useState<Partial<ThemeColors>>(overrides)
  const fallback = DEFAULT_FALLBACKS.light
  const merged = { ...fallback, ...values } as ThemeColors
  const audit = auditThemeContrast(merged)
  return (
    <div className="max-w-xl">
      <TokenGroup
        groupKey={SURFACE_GROUP.key}
        label={SURFACE_GROUP.key}
        tokens={SURFACE_GROUP.tokens}
        defaultOpen
        values={values}
        fallback={fallback}
        audit={audit}
        tokenLabel={(k) => String(k)}
        swatchAriaLabel={(k) => `${String(k)} swatch`}
        hexAriaLabel={(k) => `${String(k)} hex`}
        auditChipLabel="Low contrast"
        failureBadgeLabel={(n) => `${n} issue${n === 1 ? "" : "s"}`}
        onChange={(key, next) => setValues((prev) => ({ ...prev, [key]: next }))}
      />
    </div>
  )
}

// Multi-column layout here sizes off `@container/appearance-pane`, which
// `appearance-section.tsx` owns in the real app — the decorator stands in for
// it so this story previews the same layout the settings pane shows.
const meta = {
  title: "Settings/Appearance/TokenGroup",
  component: TokenGroup,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="@container/appearance-pane">
        <Story />
      </div>
    ),
  ],
  // Full required-args set so the render-based stories below type-check; the
  // Harness supplies its own live values, so these defaults are placeholders.
  args: {
    groupKey: SURFACE_GROUP.key,
    label: SURFACE_GROUP.key,
    tokens: SURFACE_GROUP.tokens,
    defaultOpen: true,
    values: {},
    fallback: DEFAULT_FALLBACKS.light,
    audit: auditThemeContrast(DEFAULT_FALLBACKS.light),
    tokenLabel: (k) => String(k),
    swatchAriaLabel: (k) => `${String(k)} swatch`,
    hexAriaLabel: (k) => `${String(k)} hex`,
    auditChipLabel: "Low contrast",
    failureBadgeLabel: (n) => `${n} issues`,
    onChange: fn(),
  },
} satisfies Meta<typeof TokenGroup>

export default meta
type Story = StoryObj<typeof meta>

// Healthy palette — no contrast flags.
export const Healthy: Story = {
  render: () => <Harness overrides={{}} />,
}

// A deliberately low-contrast foreground/background pair raises audit flags.
export const WithContrastFailures: Story = {
  render: () => <Harness overrides={{ background: "#fefefe", foreground: "#f5f5f5" }} />,
}
