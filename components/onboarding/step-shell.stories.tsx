import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { Button } from "@/components/ui/button"
import { FirstRunStep } from "./steps/first-run-step"
import { ProviderStep, type ProviderView } from "./steps/provider-step"
import { StepShell } from "./step-shell"
import { resolveStepSequence } from "@/lib/onboarding/steps"

/**
 * The first-run takeover (ADR-0122). Rendered `fullscreen` because that is what
 * it is: on `/onboarding` the desktop chrome is suppressed and this shell *is*
 * the window, down to its own drag region and window buttons.
 *
 * Use the toolbar's theme switch on these — the rail follows the app theme now,
 * where the version this replaced hard-coded `dark` on it and handed a
 * light-theme user a black slab.
 */
const meta = {
  title: "Onboarding/StepShell",
  component: StepShell,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StepShell>

export default meta
type Story = StoryObj<typeof meta>

const desktopSequence = resolveStepSequence({ shell: "tauri", hasModelAccess: false })

/**
 * Sign-in, wired the way `OnboardingFlow` wires it: the action row's Continue
 * stands down while the API-key panel owns the primary button. Click
 * "Use API key" to see the swap.
 */
export const SignIn: Story = {
  args: { sequence: desktopSequence, current: "provider", children: null },
  render: (args) => {
    const [view, setView] = useState<ProviderView>("chooser")
    return (
      <StepShell
        {...args}
        onBack={() => {}}
        footer={
          <>
            <Button variant="ghost" size="sm">
              Skip for now
            </Button>
            {view === "chooser" && <Button size="sm">Continue</Button>}
          </>
        }
      >
        <ProviderStep onConnected={() => {}} onViewChange={setView} />
      </StepShell>
    )
  },
}

/** The terminal step: the cards are the action, so the row carries only Skip. */
export const FirstRun: Story = {
  args: {
    sequence: desktopSequence,
    current: "first-run",
    onBack: () => {},
    footer: (
      <Button variant="ghost" size="sm">
        Skip for now
      </Button>
    ),
    children: (
      <FirstRunStep
        shell="tauri"
        capabilities={["fs", "ocr", "web"]}
        modelAccess
        character={null}
        onChangeCharacter={() => {}}
        onPick={async () => {}}
        runtimeLabel="Claude Code"
      />
    ),
  },
}

/**
 * The terminal step with no model to run on — a browser that skipped sign-in,
 * say. The cards create a session and record the flow as completed, so they
 * have to be inert here rather than fail a turn in the chat pane afterwards.
 */
export const FirstRunWithoutModel: Story = {
  args: {
    sequence: desktopSequence,
    current: "first-run",
    onBack: () => {},
    footer: (
      <Button variant="ghost" size="sm">
        Skip for now
      </Button>
    ),
    children: (
      <FirstRunStep
        shell="web"
        capabilities={["web"]}
        modelAccess={false}
        onConnectModel={() => {}}
        character={null}
        onChangeCharacter={() => {}}
        onPick={async () => {}}
      />
    ),
  },
}

/** First step in the rail — no Back, and the first bullet is the current one. */
export const FirstStep: Story = {
  args: {
    sequence: desktopSequence,
    current: "scan",
    footer: (
      <>
        <Button variant="ghost" size="sm">
          Skip for now
        </Button>
        <Button size="sm">Continue</Button>
      </>
    ),
    children: <ProviderStep onConnected={() => {}} />,
  },
}
