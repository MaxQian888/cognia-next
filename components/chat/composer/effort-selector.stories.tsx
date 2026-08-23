import type { Meta, StoryObj } from "@storybook/nextjs"

import { EffortSelector } from "./effort-selector"
import type { ChatSession } from "@cognia/agent-config-types"

// EffortSelector self-gates to `null` unless there is a session AND the active
// model supports reasoning effort (`modelSupportsEffort`). On the Anthropic path
// the effort families are Opus 4.5–4.9, Sonnet 4.6, and the Claude 5 family bar
// Haiku — NOT Sonnet 4.5 / Haiku / Opus 4.0–4.1. We pin the session to an
// effort-capable model (`claude-opus-5`); using Sonnet 4.5 would render nothing.
//
// `thinkingLevel` is the tier the control renders; `effort` is what the SDK
// receives. Production writes the two together (`thinkingLevelPatch`), so these
// fixtures keep them consistent — note `ultracode` pairing with `xhigh`.
function session(thinkingLevel?: ChatSession["thinkingLevel"]): ChatSession {
  const effort: ChatSession["effort"] =
    !thinkingLevel || thinkingLevel === "off"
      ? undefined
      : thinkingLevel === "ultracode"
        ? "xhigh"
        : thinkingLevel
  return {
    id: "sess-effort-1",
    title: "Refactor the composer toolbar",
    model: "claude-opus-5",
    providerOverride: "anthropic",
    thinkingLevel,
    effort,
  } as ChatSession
}

const meta = {
  title: "Chat/Composer/EffortSelector",
  component: EffortSelector,
  parameters: { layout: "padded" },
  // The control lives in a 360px popover; the stories reproduce that width so
  // the responsive band matches production rather than the full canvas.
  decorators: [
    (Story) => (
      <div className="w-[360px] rounded-xl border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EffortSelector>

export default meta
type Story = StoryObj<typeof meta>

// Default presentation: the Faster→Smarter track.
export const Slider: Story = {
  args: { session: session("high"), mode: "slider" },
}

// The composite top tier — xhigh effort plus the dynamic workflow tools.
export const SliderUltracode: Story = {
  args: { session: session("ultracode"), mode: "slider" },
}

// No tier chosen → the track is dimmed and "Auto" is engaged.
export const SliderAuto: Story = {
  args: { session: session(), mode: "slider" },
}

// The alternative presentation: one row per tier with its description.
export const List: Story = {
  args: { session: session("high"), mode: "list" },
}

// Narrow container → the per-tier scale is dropped, the control is not.
export const CompactSlider: Story = {
  args: { session: session("max"), mode: "slider" },
  decorators: [
    (Story) => (
      <div className="w-[240px] rounded-xl border">
        <Story />
      </div>
    ),
  ],
}

// Streaming in flight → every affordance is inert.
export const Disabled: Story = {
  args: { session: session("max"), mode: "slider", disabled: true },
}
