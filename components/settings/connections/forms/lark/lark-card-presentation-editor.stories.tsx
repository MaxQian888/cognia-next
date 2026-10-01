import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { LarkCardPresentationEditor } from "./lark-card-presentation-editor"
import { normalizeLarkCardPresentation } from "@/lib/connectors/adapters/lark/card-presentation"

const meta = {
  title: "Settings/Connections/Lark card appearance",
  component: LarkCardPresentationEditor,
  render: function Editor(args) {
    const [value, setValue] = useState(args.value)
    return (
      <div className="w-[min(40rem,calc(100vw-2rem))] p-4">
        <LarkCardPresentationEditor {...args} value={value} onChange={setValue} />
      </div>
    )
  },
  args: { value: normalizeLarkCardPresentation({}), onChange: () => undefined },
} satisfies Meta<typeof LarkCardPresentationEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Compact: Story = {
  args: {
    value: normalizeLarkCardPresentation({
      theme: "purple",
      density: "compact",
      width: "compact",
      history: "collapsed",
    }),
  },
}

export const Template: Story = {
  args: {
    value: normalizeLarkCardPresentation({
      title: "Release assistant",
      subtitle: "Build report",
      headerTags: "release, team",
      mobileTextSize: "heading-4",
      panelColorLight: "#F0F4FF",
      panelColorDark: "#202838",
      resultTemplateEnabled: true,
      resultTemplateId: "AA_example",
      resultTemplateVersion: "1.0.0",
    }),
  },
}
