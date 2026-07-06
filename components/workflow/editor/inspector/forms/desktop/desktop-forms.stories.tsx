import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import {
  DesktopScreenshotConfig,
  DesktopFindElementConfig,
  DesktopReadTreeConfig,
  DesktopClickConfig,
  DesktopTypeConfig,
  DesktopKeysConfig,
  DesktopPasteConfig,
  DesktopLaunchAppConfig,
  DesktopInvokePatternConfig,
  DesktopWindowResizeConfig,
  DesktopWaitConfig,
} from "./index"

type ConfigForm = React.ComponentType<{
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}>

function Controlled({
  Form,
  initial = {},
}: {
  Form: ConfigForm
  initial?: Record<string, unknown>
}) {
  const [params, setParams] = React.useState<Record<string, unknown>>(initial)
  return (
    <div className="w-[360px]">
      <Form params={params} onChange={setParams} />
    </div>
  )
}

// The 11 thin `action.desktop.*` inspector shells, each wrapping
// `DesktopActionForm` with kind-specific fields. One representative story per
// kind keeps the gallery scannable.
const meta = {
  title: "Workflow/Editor/Inspector/Forms/Desktop/Kinds",
  component: DesktopClickConfig,
  parameters: { layout: "padded" },
  args: { params: {}, onChange: fn() },
} satisfies Meta<typeof DesktopClickConfig>

export default meta
type Story = StoryObj<typeof meta>

export const Screenshot: Story = {
  render: () => (
    <Controlled
      Form={DesktopScreenshotConfig}
      initial={{ format: "png", fullScreen: true, outputPath: "C:/captures/shot.png" }}
    />
  ),
}

export const FindElement: Story = {
  render: () => (
    <Controlled Form={DesktopFindElementConfig} initial={{ selector: 'role:Edit name:"Search"' }} />
  ),
}

export const ReadTree: Story = {
  render: () => <Controlled Form={DesktopReadTreeConfig} initial={{ maxDepth: 4 }} />,
}

export const Click: Story = {
  render: () => (
    <Controlled
      Form={DesktopClickConfig}
      initial={{ selector: 'role:Button name:"OK"', button: "left", clickCount: 2 }}
    />
  ),
}

export const Type: Story = {
  render: () => (
    <Controlled
      Form={DesktopTypeConfig}
      initial={{ selector: "automationId:input", text: "Hello {{ $json.name }}", delayMs: 25 }}
    />
  ),
}

export const Keys: Story = {
  render: () => <Controlled Form={DesktopKeysConfig} initial={{ chord: "Ctrl+Shift+P" }} />,
}

export const Paste: Story = {
  render: () => <Controlled Form={DesktopPasteConfig} initial={{ text: "clipboard payload" }} />,
}

export const LaunchApp: Story = {
  render: () => (
    <Controlled Form={DesktopLaunchAppConfig} initial={{ app: "notepad.exe", action: "launch" }} />
  ),
}

export const InvokePattern: Story = {
  render: () => (
    <Controlled
      Form={DesktopInvokePatternConfig}
      initial={{ selector: "role:Slider", pattern: "rangeValue", value: "50" }}
    />
  ),
}

export const WindowResize: Story = {
  render: () => (
    <Controlled Form={DesktopWindowResizeConfig} initial={{ width: 1440, height: 900 }} />
  ),
}

export const Wait: Story = {
  render: () => (
    <Controlled
      Form={DesktopWaitConfig}
      initial={{ selector: "automationId:spinner", eventKind: "elementHidden" }}
    />
  ),
}
