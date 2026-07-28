import type { Meta, StoryObj } from "@storybook/nextjs"

import { ErrorParsedView } from "./error-parsed-view"

// `ErrorParsedView` is fully props-driven — it normalizes + parses `rawError`
// (or `rawText`) through the resolved error preset and renders the structured
// nodes (categories, status codes, stack frames, JSON). No store / sidecar.

const meta = {
  title: "Chat/ErrorParsedView",
  component: ErrorParsedView,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ErrorParsedView>

export default meta
type Story = StoryObj<typeof meta>

// A rate-limit HTTP error — the parser recognises the 429 + category, drawing
// the colored status badge and the localized hint, with the raw/parsed toggle.
export const RateLimited: Story = {
  args: {
    rawError:
      "Request failed with status code 429: rate_limit_error — Number of requests has exceeded your per-minute limit.",
  },
}

// A Node stack trace — clickable frames that route into the file viewer.
export const StackTrace: Story = {
  args: {
    rawError: [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "    at resolveSession (lib/chat/branch-session.ts:88:21)",
      "    at async onConfirm (components/chat/branch-dialog.tsx:111:23)",
      "    at async dispatch (lib/claude/ipc.ts:204:5)",
    ].join("\n"),
  },
}

// Unrecognised text — falls through to a plain render with no toggle.
export const PlainFallback: Story = {
  args: {
    rawError: "",
    fallback: "Something went wrong while contacting the model.",
  },
}
