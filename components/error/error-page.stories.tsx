import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ErrorPage } from "./error-page"

const sampleError: Error & { digest?: string } = Object.assign(
  new Error("Cannot read properties of undefined (reading 'map')"),
  {
    digest: "e7f3a9c2",
    stack:
      "TypeError: Cannot read properties of undefined (reading 'map')\n" +
      "    at ArtifactList (artifact-list.tsx:206:31)\n" +
      "    at renderWithHooks (react-dom.js:15012:18)",
  }
)

// Route-level error / not-found / global-error renderer. Renders entirely from
// props, so each variant is a static screen.
const meta = {
  title: "Error/ErrorPage",
  component: ErrorPage,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-[600px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ErrorPage>

export default meta
type Story = StoryObj<typeof meta>

export const RuntimeError: Story = {
  args: { variant: "error", error: sampleError, reset: fn() },
}

export const NotFound: Story = {
  args: { variant: "not-found" },
}

// `staticLocale="en"` is the global-error path that renders without the intl /
// router providers.
export const GlobalErrorStatic: Story = {
  args: { variant: "global-error", error: sampleError, reset: fn(), staticLocale: "en" },
}
