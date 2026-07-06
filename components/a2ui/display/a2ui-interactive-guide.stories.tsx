import type { Meta, StoryObj, Decorator } from "@storybook/nextjs"

import { A2UIInteractiveGuide } from "./a2ui-interactive-guide"
import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import type {
  A2UIGuideStep,
  A2UIInteractiveGuideComponentDef,
} from "@/types/a2ui/interactive-guide"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"

const STEPS: A2UIGuideStep[] = [
  {
    id: "connect",
    title: "Connect a platform",
    description: "Link Slack, Lark, or Telegram so the agent can reach your team.",
    content: ["connect-body"],
  },
  {
    id: "configure",
    title: "Configure routing",
    description: "Choose which conversations the agent should respond to automatically.",
    content: ["configure-body"],
  },
  {
    id: "review",
    title: "Review and launch",
    description: "Confirm the settings and turn the assistant on.",
    content: ["review-body"],
    isOptional: true,
  },
]

const guide = (
  over: Partial<A2UIInteractiveGuideComponentDef> = {}
): A2UIInteractiveGuideComponentDef => ({
  id: "guide",
  component: "InteractiveGuide",
  title: "Getting started",
  steps: STEPS,
  ...over,
})

// Step bodies are rendered through `renderChild`; provide placeholder content.
const renderChild = (componentId: string) => (
  <div className="rounded-md bg-muted px-4 py-6 text-sm text-muted-foreground">
    Step content for &ldquo;{componentId}&rdquo;
  </div>
)

const withA2UI: Decorator = (Story) => (
  <A2UIProvider surfaceId="story-surface" renderComponent={() => null}>
    <Story />
  </A2UIProvider>
)

const meta = {
  title: "A2UI/Display/InteractiveGuide",
  component: A2UIInteractiveGuide,
  decorators: [withA2UI],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIInteractiveGuide>

export default meta
type Story = StoryObj<typeof meta>

export const ThreeSteps: Story = {
  args: makeA2UIProps(guide(), { renderChild }),
}

export const WithSkip: Story = {
  args: makeA2UIProps(guide({ allowSkip: true, onSkip: "skip-guide" }), { renderChild }),
}

export const WithoutProgress: Story = {
  args: makeA2UIProps(guide({ showProgress: false }), { renderChild }),
}

export const WithoutNavigation: Story = {
  args: makeA2UIProps(guide({ showNavigation: false }), { renderChild }),
}

export const SingleStep: Story = {
  args: makeA2UIProps(
    guide({
      title: "One-step tour",
      steps: [
        {
          id: "only",
          title: "Welcome aboard",
          description: "This guide has a single step.",
          content: ["only-body"],
        },
      ],
    }),
    { renderChild }
  ),
}

export const NoSteps: Story = {
  args: makeA2UIProps(guide({ title: "Empty guide", steps: [] }), { renderChild }),
}
