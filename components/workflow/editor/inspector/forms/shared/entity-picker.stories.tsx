import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EntityPicker, type EntityOption } from "./entity-picker"

// `EntityPicker` is the base combobox the Dexie-backed wrappers (CharacterPicker,
// TeamPicker, …) render. It is purely props-driven via `options`, so a story can
// hand it a static list without seeding IndexedDB. The wrappers themselves read
// live data and render empty (or expression mode) without seeded tables.
const options: EntityOption[] = [
  { value: "char_ada", label: "Ada — Research assistant" },
  { value: "char_grace", label: "Grace — Code reviewer" },
  { value: "char_alan", label: "Alan — Ops responder" },
]

function Controlled({
  initial = "",
  ...rest
}: {
  initial?: string
  options: EntityOption[]
  placeholder?: string
  allowEmpty?: boolean
  allowExpression?: boolean
}) {
  const [value, setValue] = React.useState(initial)
  return (
    <div className="w-[300px]">
      <EntityPicker id="story-picker" value={value} onChange={setValue} {...rest} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/Shared/EntityPicker",
  component: EntityPicker,
  parameters: { layout: "centered" },
  args: { id: "story-picker", value: "", onChange: fn(), options },
} satisfies Meta<typeof EntityPicker>

export default meta
type Story = StoryObj<typeof meta>

// A selected value resolves to its label in the trigger.
export const Selected: Story = {
  render: () => (
    <Controlled initial="char_grace" options={options} placeholder="Pick a character" />
  ),
}

// Nothing selected — placeholder shown, expression toggle available.
export const Empty: Story = {
  render: () => <Controlled options={options} placeholder="Pick a character" allowExpression />,
}

// `allowEmpty` prepends a "none" item that clears the value.
export const Clearable: Story = {
  render: () => <Controlled initial="char_ada" options={options} allowEmpty placeholder="Pick" />,
}

// Expression value forces the raw text / `{{ }}` mode.
export const ExpressionMode: Story = {
  render: () => (
    <Controlled initial="{{ $node['router'].out.characterId }}" options={options} allowExpression />
  ),
}
