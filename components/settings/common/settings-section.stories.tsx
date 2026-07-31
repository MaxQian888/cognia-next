import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { BellIcon, KeyRoundIcon, PaletteIcon, ShieldAlertIcon, SparklesIcon } from "lucide-react"

import {
  SaveButton,
  SettingsAlert,
  SettingsCard,
  SettingsDivider,
  SettingsEmptyState,
  SettingsGrid,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsToggle,
} from "./settings-section"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// These are the shared layout primitives every settings section composes from.
// The default story drives `SettingsCard`; the others use `render` to showcase
// each primitive in isolation. Toggle the Theme toolbar to check dark mode.
const meta = {
  title: "Settings/Common/SettingsSection",
  component: SettingsCard,
  // `SettingsCard` requires `title` + `children`. The render-only stories below
  // showcase the *other* primitives via `render`, so they inherit these defaults
  // to satisfy the required-args contract without affecting their output.
  args: {
    title: "Appearance",
    children: <p className="text-sm text-muted-foreground">Card body content goes here.</p>,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SettingsCard>

export default meta
type Story = StoryObj<typeof meta>

export const Card: Story = {
  args: {
    icon: <PaletteIcon className="size-4" />,
    title: "Appearance",
    description: "Theme, density, and accent color.",
    badge: "New",
    children: (
      <p className="text-sm text-muted-foreground">
        Card body content goes here. Rows, grids, and toggles slot in below.
      </p>
    ),
  },
}

export const CollapsibleCard: Story = {
  args: {
    icon: <ShieldAlertIcon className="size-4" />,
    title: "Advanced",
    description: "Rarely-changed options.",
    collapsible: true,
    defaultOpen: false,
    children: <p className="text-sm text-muted-foreground">Expand to reveal advanced settings.</p>,
  },
}

/** A single row with an arbitrary control on the right. */
export const Row: Story = {
  render: () => (
    <SettingsRow
      icon={<KeyRoundIcon />}
      label="API key"
      description="Used to authenticate outbound requests."
    >
      <Input className="w-48" placeholder="sk-…" />
    </SettingsRow>
  ),
}

function ToggleDemo() {
  const [notify, setNotify] = useState(true)
  const [beta, setBeta] = useState(false)
  return (
    <div className="space-y-2">
      <SettingsToggle
        id="notify"
        icon={<BellIcon />}
        label="Notifications"
        description="Show desktop notifications for new messages."
        checked={notify}
        onCheckedChange={setNotify}
      />
      <SettingsToggle
        id="beta"
        icon={<SparklesIcon />}
        label="Beta features"
        description="Opt into experimental, unstable functionality."
        checked={beta}
        onCheckedChange={setBeta}
      />
    </div>
  )
}

export const Toggles: Story = {
  render: () => <ToggleDemo />,
}

export const Grid: Story = {
  render: () => (
    <SettingsGrid columns={2}>
      <SettingsRow label="Density" description="Comfortable">
        <Button size="sm" variant="outline">
          Change
        </Button>
      </SettingsRow>
      <SettingsRow label="Accent" description="Blue">
        <Button size="sm" variant="outline">
          Change
        </Button>
      </SettingsRow>
    </SettingsGrid>
  ),
}

export const Divider: Story = {
  render: () => (
    <div>
      <p className="text-sm text-muted-foreground">Above</p>
      <SettingsDivider label="Danger zone" />
      <p className="text-sm text-muted-foreground">Below</p>
    </div>
  ),
}

export const Group: Story = {
  render: () => (
    <SettingsGroup title="Experimental" icon={<SparklesIcon className="size-4" />} badge="3">
      <SettingsRow label="Use new renderer">
        <Button size="sm" variant="outline">
          Off
        </Button>
      </SettingsRow>
    </SettingsGroup>
  ),
}

export const Alert: Story = {
  render: () => (
    <SettingsAlert
      variant="destructive"
      icon={<ShieldAlertIcon className="size-4" />}
      title="Unsaved changes"
      action={
        <Button size="sm" variant="outline">
          Discard
        </Button>
      }
    >
      You have edits that haven&apos;t been saved yet.
    </SettingsAlert>
  ),
}

export const EmptyState: Story = {
  render: () => (
    <SettingsEmptyState
      icon={<KeyRoundIcon />}
      title="No API keys yet"
      description="Add a key to start making authenticated requests."
      action={<Button size="sm">Add key</Button>}
    />
  ),
}

export const PageHeader: Story = {
  render: () => (
    <SettingsPageHeader
      icon={<PaletteIcon className="size-5" />}
      title="Appearance"
      description="Customize how the app looks."
      actions={
        <Button size="sm" variant="outline">
          Reset
        </Button>
      }
    />
  ),
}

/** Click to see the loading → success transition (label is i18n-driven). */
export const Save: Story = {
  render: () => <SaveButton onClick={() => new Promise((resolve) => setTimeout(resolve, 800))} />,
}
