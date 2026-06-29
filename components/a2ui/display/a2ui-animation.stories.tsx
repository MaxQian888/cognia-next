import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIAnimation } from "./a2ui-animation"
import type { A2UIAnimationComponentDef } from "@/types/a2ui/animation"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const animation = (over: Partial<A2UIAnimationComponentDef> = {}): A2UIAnimationComponentDef => ({
  id: "animation",
  component: "Animation",
  type: "fadeIn",
  children: ["child"],
  ...over,
})

// The renderer animates whatever `renderChild` returns; supply visible content
// so the motion wrapper has something to reveal.
const renderChild = () => (
  <div className="rounded-md border bg-card px-6 py-4 text-sm shadow-sm">Animated content</div>
)

const meta = {
  title: "A2UI/Display/Animation",
  component: A2UIAnimation,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIAnimation>

export default meta
type Story = StoryObj<typeof meta>

export const FadeIn: Story = {
  args: makeA2UIProps(animation({ type: "fadeIn" }), { renderChild }),
}

export const SlideInUp: Story = {
  args: makeA2UIProps(animation({ type: "slideIn", direction: "up" }), { renderChild }),
}

export const SlideInLeft: Story = {
  args: makeA2UIProps(animation({ type: "slideIn", direction: "left" }), { renderChild }),
}

export const Scale: Story = {
  args: makeA2UIProps(animation({ type: "scale" }), { renderChild }),
}

export const Bounce: Story = {
  args: makeA2UIProps(animation({ type: "bounce" }), { renderChild }),
}

export const Pulse: Story = {
  args: makeA2UIProps(animation({ type: "pulse", repeat: "infinite" }), { renderChild }),
}

export const Shake: Story = {
  args: makeA2UIProps(animation({ type: "shake" }), { renderChild }),
}

export const Highlight: Story = {
  args: makeA2UIProps(animation({ type: "highlight" }), { renderChild }),
}

export const DelayedSlow: Story = {
  args: makeA2UIProps(animation({ type: "fadeIn", duration: 1.5, delay: 0.5 }), { renderChild }),
}
