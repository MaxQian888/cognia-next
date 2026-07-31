import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetModelMotionEditor } from "./pet-model-motion-editor"
import type { Live2dMotionOverrides } from "@/types/pet"

// Pure, props-only: one row per mappable visual state / one-shot. The select
// options derive from the model's declared `motionGroups` / `expressionIds`;
// `value` is the override table, `onChange` / `onTest` are spies.
const MOTION_GROUPS = ["Idle", "TapBody", "FlickHead"]
const EXPRESSION_IDS = ["F01", "F02", "F03"]
const COUNTS: Record<string, number> = { Idle: 3, TapBody: 2, FlickHead: 1 }

const OVERRIDES: Live2dMotionOverrides = {
  // A resting state mapped to a fixed motion + expression.
  idle: { motionGroup: "Idle", motionIndex: 0, expressionId: "F01" },
  // "Engine default" — empty entry suppresses the naming-convention mapping.
  thinking: {},
  // A namespaced one-shot mapped to a random index within a group.
  "shot:wave": { motionGroup: "TapBody", expressionId: "F02" },
}

const meta = {
  title: "Settings/Pet/PetModelMotionEditor",
  component: PetModelMotionEditor,
  parameters: { layout: "padded" },
  args: {
    motionGroups: MOTION_GROUPS,
    expressionIds: EXPRESSION_IDS,
    motionGroupCounts: COUNTS,
    value: {},
    onChange: fn(),
    onTest: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetModelMotionEditor>

export default meta
type Story = StoryObj<typeof meta>

// Every row at its naming-convention default (no overrides set).
export const Default: Story = {}

// A few rows overridden — fixed motion, engine default, and a one-shot mapping.
export const WithOverrides: Story = {
  args: { value: OVERRIDES },
}

// A model that declares no motion groups or expressions — selects offer only
// the default / engine sentinels.
export const NoCapabilities: Story = {
  args: { motionGroups: [], expressionIds: [], motionGroupCounts: {} },
}
