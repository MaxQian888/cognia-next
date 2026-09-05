import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PairFailurePanel } from "./pair-failure-panel"
import type { PairFailure } from "./pair-failure"

const BASE: PairFailure = {
  stage: "register",
  kind: "origin_blocked",
  detail: "TypeError: Failed to fetch",
  remedies: ["enableBrowserAccess", "allowlistOrigin", "freshInvitation"],
  retryable: false,
  invitationSpent: false,
  baseUrl: "http://127.0.0.1:27891",
  origin: "http://127.0.0.1:3000",
  loopbackUrl: "http://127.0.0.1:27891",
}

const meta = {
  title: "Mobile/Pair/PairFailurePanel",
  component: PairFailurePanel,
  parameters: { layout: "centered" },
  args: { failure: BASE, onStartOver: fn() },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PairFailurePanel>

export default meta
type Story = StoryObj<typeof meta>

/** The Host answered but refuses this browser origin — the common CORS case. */
export const OriginBlocked: Story = {}

/**
 * A LAN `https://` Host presenting a self-signed certificate. Previously the
 * entire user-facing text here was "Failed to fetch".
 */
export const CertificateUntrusted: Story = {
  args: {
    failure: {
      ...BASE,
      kind: "tls_untrusted",
      baseUrl: "https://192.168.1.42:27890",
      remedies: ["enableBrowserAccess", "useLoopbackInvitation", "freshInvitation"],
    },
  },
}

/**
 * The device IS registered on the Host and the invitation IS spent — only the
 * local key store refused. "Pair again" was the old, actively wrong advice.
 */
export const VaultLocked: Story = {
  args: {
    failure: {
      ...BASE,
      stage: "persist",
      kind: "vault_locked",
      detail: "Browser Vault must be unlocked to reach companion credentials.",
      remedies: ["unlockAccount", "freshInvitation", "removeStaleDevice"],
      invitationSpent: true,
    },
  },
}

/** Paired successfully; only bringing the Host online failed. Retry is safe. */
export const ActivationFailed: Story = {
  args: {
    failure: {
      ...BASE,
      stage: "activate",
      kind: "activate_failed",
      detail: "host_feature_manifest timed out after 10000ms",
      remedies: ["reloadAndRetry", "checkHostRunning", "checkHostLogs"],
      retryable: true,
      invitationSpent: true,
    },
    onRetry: fn(),
  },
}

/** A readable HTTP refusal, with the Host's own code preserved. */
export const HostRejected: Story = {
  args: {
    failure: {
      ...BASE,
      kind: "http",
      status: 401,
      code: "invitation_consumed",
      detail: "invitation already used",
      remedies: ["freshInvitation", "removeStaleDevice"],
      invitationSpent: true,
    },
  },
}
