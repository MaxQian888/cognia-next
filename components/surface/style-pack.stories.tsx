import type { Meta, StoryObj } from "@storybook/nextjs"
import { useEffect } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { resolveStylePackDom } from "@/lib/appearance/style-pack-applier"
import { resolveStylePack, type StylePackId } from "@/types/appearance/style-pack"
import { Surface } from "./surface"

/**
 * Side-by-side preview of the three style packs (ADR-0148).
 *
 * The pack's effect lives in rules keyed on `<html>` (`data-style-pack`,
 * `data-elevation-max`, …), so the decorator writes exactly what
 * `StylePackApplier` writes at runtime rather than faking it on a wrapper —
 * otherwise the preview would be a different code path from the product.
 */
function PackDecorator({ packId, children }: { packId: StylePackId; children: React.ReactNode }) {
  useEffect(() => {
    const root = document.documentElement
    const pack = resolveStylePack({ packId })
    const { vars, attrs } = resolveStylePackDom({ packId })
    root.style.setProperty("--radius", `${pack.radiusBaseRem}rem`)
    for (const [name, value] of Object.entries(vars)) {
      if (value) root.style.setProperty(name, value)
      else root.style.removeProperty(name)
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (value) root.setAttribute(name, value)
      else root.removeAttribute(name)
    }
    return () => {
      root.style.removeProperty("--radius")
      for (const name of Object.keys(vars)) root.style.removeProperty(name)
      for (const name of Object.keys(attrs)) root.removeAttribute(name)
    }
  }, [packId])
  return <>{children}</>
}

function Specimen() {
  return (
    <div className="flex max-w-md flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Card
            <Badge>badge</Badge>
            <Badge variant="outline">outline</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="Input" />
          <Progress value={62} />
          <div className="flex items-center gap-3">
            <Switch defaultChecked />
            <Button size="sm">Primary</Button>
            <Button size="sm" variant="outline">
              Outline
            </Button>
          </div>
          <span
            data-micro-label
            className="text-[11px] text-muted-foreground"
            title="Follows the pack's micro-label treatment"
          >
            12:04 · 3 runs · queued
          </span>
        </CardContent>
      </Card>

      <Alert>
        <AlertTitle>Alert</AlertTitle>
        <AlertDescription>Both variants sit on the raised tier.</AlertDescription>
      </Alert>

      <div className="flex gap-3">
        <Surface layer="base" radius="panel" className="flex-1 border p-3 text-xs">
          base
        </Surface>
        <Surface layer="raised" radius="panel" elevation={2} className="flex-1 border p-3 text-xs">
          raised
        </Surface>
        <Surface layer="overlay" radius="panel" elevation={3} className="flex-1 border p-3 text-xs">
          overlay
        </Surface>
      </div>
    </div>
  )
}

const meta = {
  title: "Appearance/StylePack",
  parameters: { layout: "padded" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Soft: Story = {
  render: () => (
    <PackDecorator packId="soft">
      <Specimen />
    </PackDecorator>
  ),
}

export const Studio: Story = {
  render: () => (
    <PackDecorator packId="studio">
      <Specimen />
    </PackDecorator>
  ),
}

export const Sharp: Story = {
  render: () => (
    <PackDecorator packId="sharp">
      <Specimen />
    </PackDecorator>
  ),
}
