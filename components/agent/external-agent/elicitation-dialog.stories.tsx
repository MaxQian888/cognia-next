import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import type { AcpElicitationRequest } from "@/types/agent/external-agent"

import { ExternalAgentElicitationDialog } from "./elicitation-dialog"

/** Shape a Pi dialog exactly as `piDialogSchema` does: one property per method. */
function piRequest(
  method: string,
  property: Record<string, unknown>,
  message: string,
  id = `dlg-${method}`
): AcpElicitationRequest {
  return {
    id,
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      title: property.title as string,
      properties: { [method]: property as never },
      required: [method],
    },
    raw: { method },
  }
}

const meta = {
  title: "Agent/ExternalAgent/ElicitationDialog",
  component: ExternalAgentElicitationDialog,
  parameters: { layout: "centered" },
  args: { onRespond: fn() },
} satisfies Meta<typeof ExternalAgentElicitationDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Confirm: Story = {
  args: {
    request: piRequest(
      "confirm",
      { type: "boolean", title: "Delete the build output?" },
      "dist/ contains 412 files."
    ),
  },
}

export const Select: Story = {
  args: {
    request: piRequest(
      "select",
      { type: "string", title: "Branch", enum: ["main", "dev", "release/2.1"] },
      "Which branch should the change target?"
    ),
  },
}

export const Input: Story = {
  args: {
    request: piRequest(
      "input",
      { type: "string", title: "Name", description: "lowercase, no spaces" },
      "What should the new workspace be called?"
    ),
  },
}

/** A prefilled string renders as a textarea — the user revises, not retypes. */
export const Editor: Story = {
  args: {
    request: piRequest(
      "editor",
      {
        type: "string",
        title: "Commit message",
        default:
          "fix(agent): stop dropping elicitation requests\n\nThe renderer had no surface for them.",
      },
      "Review the commit message before it is written."
    ),
  },
}

/** ACP's url mode, with the homograph warning it can carry. */
export const UrlWithPunycodeWarning: Story = {
  args: {
    request: {
      id: "dlg-url",
      mode: "url",
      message: "Finish signing in to continue.",
      url: "https://xn--80ak6aa92e.com/auth?state=abc",
      origin: "https://xn--80ak6aa92e.com",
      hasPunycodeWarning: true,
      raw: {},
    },
  },
}
