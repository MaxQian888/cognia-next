import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { PaletteIcon, ShapesIcon, SunMoonIcon, TypeIcon, WrenchIcon } from "lucide-react"

import { SettingsMasterDetail } from "./settings-master-detail"
import { SettingsPanelNav, type SettingsNavGroup } from "./settings-panel-nav"

type Id = "style" | "theme" | "auto" | "typography" | "advanced"
type GroupId = "themeGroup" | "advancedGroup"

const GROUPS: readonly SettingsNavGroup<Id, GroupId>[] = [
  {
    id: "themeGroup",
    items: [
      { id: "style", icon: ShapesIcon },
      { id: "theme", icon: PaletteIcon },
      { id: "auto", icon: SunMoonIcon },
    ],
  },
  {
    id: "advancedGroup",
    items: [
      { id: "typography", icon: TypeIcon },
      { id: "advanced", icon: WrenchIcon },
    ],
  },
]

const COPY: Record<Id, { label: string; description: string }> = {
  style: { label: "Style", description: "Corners, capsules, elevation, density" },
  theme: { label: "Theme and presets", description: "Preset palettes and light/dark mode" },
  auto: { label: "Auto light/dark", description: "Switch on a schedule or with the system" },
  typography: { label: "Type and density", description: "Fonts, size, spacing, corner radius" },
  advanced: { label: "Custom CSS", description: "Inject your own stylesheet" },
}

function Demo() {
  const [active, setActive] = useState<Id>("theme")
  return (
    <SettingsMasterDetail
      nav={(slot) => (
        <SettingsPanelNav<Id, GroupId>
          groups={GROUPS}
          activeId={active}
          onSelect={setActive}
          idPrefix={`demo-${slot}`}
          labels={{
            title: "Appearance sections",
            group: (id) => (id === "themeGroup" ? "THEME" : "ADVANCED"),
            item: (id) => COPY[id],
          }}
        />
      )}
      navTitle="Appearance sections"
      mobileTriggerLabel="Sections"
      activeKey={active}
      activeLabel={COPY[active].label}
      navWidth={320}
    >
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
        <div className="shrink-0 border-b p-3">
          <p className="truncate text-sm font-medium">{COPY[active].label}</p>
          <p className="truncate text-[11px] text-muted-foreground">{COPY[active].description}</p>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {["Light", "Dark", "Follow system"].map((option) => (
            <label key={option} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <input type="radio" name="demo-theme" defaultChecked={option === "Follow system"} />
              {option}
            </label>
          ))}
        </div>
      </div>
    </SettingsMasterDetail>
  )
}

// The shared master/detail frame for settings sections whose master is a nav.
//
// The three stories below are the three tiers, and the widths are the point:
// each decorator is a pane, not a viewport, because that is what the frame
// measures. The real pane is the window minus the app rail (~56px) minus the
// settings sidebar (15rem) minus the shell padding, which is why a viewport
// `md:` breakpoint used to fire while there was only ~440px to split.
const meta = {
  title: "Settings/Common/SettingsMasterDetail",
  component: Demo,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Demo>

export default meta
type Story = StoryObj<typeof meta>

const pane = (width: number) =>
  function PaneDecorator(Story: () => React.ReactElement) {
    return (
      <div className="h-screen p-4">
        <div className="flex h-full flex-col" style={{ width }}>
          <Story />
        </div>
      </div>
    )
  }

/** >= 860px — the rail carries an icon, a label and a description. */
export const FullRail: Story = { decorators: [pane(940)] }

/** 620–859px — descriptions drop out; the rail is 200px of icon + label. */
export const CompactRail: Story = { decorators: [pane(700)] }

/** 440–619px — only the glyph is painted; the label stays in the a11y tree. */
export const IconRail: Story = { decorators: [pane(500)] }

/** < 440px — no rail at all; the nav moves into a drawer. */
export const Drawer: Story = { decorators: [pane(380)] }
