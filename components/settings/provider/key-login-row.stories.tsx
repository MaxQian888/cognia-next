import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { KeyLoginRow } from "./key-login-row"

import type { ApiKeyValidationResult } from "@cognia/provider-core/providers/api-key-login"

const settle = (result: ApiKeyValidationResult) => async () => result

const meta = {
  title: "Settings/Provider/KeyLoginRow",
  component: KeyLoginRow,
  parameters: { layout: "centered" },
} satisfies Meta<typeof KeyLoginRow>

export default meta
type Story = StoryObj<typeof meta>

/** A provider whose console page and probe are both derived from the catalog. */
export const Derived: Story = {
  args: { providerId: "moonshot", apiKey: "sk-example" },
}

/** No key saved yet, so there is nothing to verify. */
export const NothingToVerify: Story = {
  args: { providerId: "moonshot" },
}

export const KeyAccepted: Story = {
  args: {
    providerId: "moonshot",
    apiKey: "sk-example",
    validate: settle({ status: "valid" }),
  },
}

export const KeyRejected: Story = {
  args: {
    providerId: "moonshot",
    apiKey: "sk-wrong",
    validate: settle({ status: "invalid", message: "invalid api key" }),
  },
}

/** Offline or throttled. Says nothing about the key, and must not read as a rejection. */
export const CouldNotVerify: Story = {
  args: {
    providerId: "moonshot",
    apiKey: "sk-example",
    validate: settle({ status: "unverified", message: "network unreachable" }),
  },
}
