import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIInputGroup, type A2UIInputGroupComponent } from "./a2ui-input-group"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"

// `A2UIInputGroup` is a container that renders each child id through the
// `renderChild` prop (no A2UI context needed). The fixture's default
// `renderChild` returns null, so stories pass a type-correct one that renders
// real input-group slots (addon + input) to make the group meaningful.
const renderChild = (childId: string) =>
  childId === "input" ? (
    <InputGroupInput key={childId} placeholder="example.com" />
  ) : (
    <InputGroupAddon key={childId}>
      <InputGroupText>{childId}</InputGroupText>
    </InputGroupAddon>
  )

const inputGroup = (over: Partial<A2UIInputGroupComponent> = {}): A2UIInputGroupComponent => ({
  id: "url",
  component: "InputGroup",
  children: ["https://", "input"],
  ...over,
})

const meta = {
  title: "A2UI/Form/InputGroup",
  component: A2UIInputGroup,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIInputGroup>

export default meta
type Story = StoryObj<typeof meta>

export const WithPrefix: Story = {
  args: makeA2UIProps(inputGroup(), { renderChild }),
}

export const WithSuffix: Story = {
  args: makeA2UIProps(inputGroup({ children: ["input", ".com"] }), { renderChild }),
}

// No children — exercises the empty container path.
export const Empty: Story = { args: makeA2UIProps(inputGroup({ children: [] })) }
