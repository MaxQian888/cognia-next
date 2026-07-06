import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIButtonGroup, type A2UIButtonGroupComponent } from "./a2ui-button-group"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { Button } from "@/components/ui/button"

// `A2UIButtonGroup` is a container: it renders each child id through the
// `renderChild` prop (no A2UI context needed). The fixture's default
// `renderChild` returns null, so stories pass a type-correct one that renders
// real buttons to make the group meaningful.
const renderButton = (childId: string) => (
  <Button key={childId} variant="outline" size="sm">
    {childId}
  </Button>
)

const buttonGroup = (over: Partial<A2UIButtonGroupComponent> = {}): A2UIButtonGroupComponent => ({
  id: "actions",
  component: "ButtonGroup",
  children: ["Save", "Cancel"],
  ...over,
})

const meta = {
  title: "A2UI/Form/ButtonGroup",
  component: A2UIButtonGroup,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIButtonGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
  args: makeA2UIProps(buttonGroup(), { renderChild: renderButton }),
}

export const Vertical: Story = {
  args: makeA2UIProps(buttonGroup({ orientation: "vertical" }), { renderChild: renderButton }),
}

export const ThreeButtons: Story = {
  args: makeA2UIProps(buttonGroup({ children: ["Bold", "Italic", "Underline"] }), {
    renderChild: renderButton,
  }),
}

// No children — exercises the empty container path.
export const Empty: Story = { args: makeA2UIProps(buttonGroup({ children: [] })) }
