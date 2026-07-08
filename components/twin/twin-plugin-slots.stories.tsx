import type { Meta, StoryObj } from "@storybook/nextjs"
import { useEffect } from "react"

import { createExtensionAPI } from "@/lib/plugin/api"
import { Card } from "@/components/ui/card"
import type { ExtensionProps } from "@/types/plugin/plugin"
import {
  TwinHeaderPluginSlot,
  TwinPersonaPluginSlot,
  TwinSettingsPluginSlot,
  TwinOverviewPluginSlot,
} from "./twin-plugin-slots"

// The four twin extension points render nothing until a plugin registers a
// component. The `Populated` story registers a demo contribution for each so
// the anchors are visible in isolation; `Empty` shows the default
// (invisible) state a user without a twin plugin sees.

const POINTS = [
  "twin.panel.header",
  "twin.persona.panel",
  "twin.settings.cards",
  "twin.overview.panel",
] as const

function DemoContribution({ context }: ExtensionProps & { context?: Record<string, unknown> }) {
  return (
    <Card className="p-3 text-sm">
      <div className="font-medium">Demo plugin contribution</div>
      <pre className="text-muted-foreground mt-1 text-xs">{JSON.stringify(context, null, 2)}</pre>
    </Card>
  )
}

function AllSlots() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs uppercase tracking-wide">Header</h3>
        <TwinHeaderPluginSlot twinId="twin-demo" tab="sources" />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs uppercase tracking-wide">Persona panel</h3>
        <TwinPersonaPluginSlot
          twinId="twin-demo"
          entityCount={4}
          playbookCount={2}
          styleCount={7}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs uppercase tracking-wide">Settings cards</h3>
        <TwinSettingsPluginSlot twinId="twin-demo" />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs uppercase tracking-wide">Overview tile</h3>
        <TwinOverviewPluginSlot twinId="twin-demo" sourceCount={12} chunkCount={340} />
      </section>
    </div>
  )
}

const meta = {
  title: "Twin/PluginSlots",
  component: AllSlots,
  parameters: { layout: "padded" },
} satisfies Meta<typeof AllSlots>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const Populated: Story = {
  decorators: [
    function WithDemoPlugin(Story) {
      useEffect(() => {
        const api = createExtensionAPI("__storybook-twin-demo")
        const unregister = POINTS.map((point) => api.registerExtension(point, DemoContribution))
        return () => unregister.forEach((fn) => fn())
      }, [])
      return <Story />
    },
  ],
}
