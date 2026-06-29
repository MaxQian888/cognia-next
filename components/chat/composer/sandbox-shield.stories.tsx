import type { Meta, StoryObj } from "@storybook/nextjs"

import { SandboxShield } from "./sandbox-shield"

// Composer shield indicator (ADR-0028). Shape is paired with colour for
// colour-blind safety. `forceState` bypasses the precedence resolver so each
// visual state is shown directly. Hover for the tooltip.
const meta = {
  title: "Chat/Composer/SandboxShield",
  component: SandboxShield,
  parameters: { layout: "centered" },
  args: { session: null },
} satisfies Meta<typeof SandboxShield>

export default meta
type Story = StoryObj<typeof meta>

/** Sandbox enabled, OS tier — filled emerald shield. */
export const OsTier: Story = { args: { forceState: "os" } }

/** Sandbox enabled, microvm tier — dashed sky shield. */
export const MicrovmTier: Story = { args: { forceState: "microvm" } }

/** Sandbox disabled — crossed muted shield (today's default). */
export const Off: Story = { args: { forceState: "off" } }
