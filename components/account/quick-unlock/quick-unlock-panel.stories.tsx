import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { QuickUnlockPanel } from "./quick-unlock-panel"
import {
  MAX_QUICK_UNLOCK_ATTEMPTS,
  type QuickUnlockEnrollment,
} from "@/lib/accounts/quick-unlock/types"

function enrollment(patch: Partial<QuickUnlockEnrollment> = {}): QuickUnlockEnrollment {
  return { method: "pin", verifier: {}, createdAt: 0, failedAttempts: 0, ...patch }
}

function Harness(props: { enrollments: QuickUnlockEnrollment[]; alwaysWrong?: boolean }) {
  return (
    <div className="mx-auto max-w-sm p-6">
      <QuickUnlockPanel
        accountId="acct-demo"
        enrollments={props.enrollments}
        onUsePassword={() => {}}
        onQuickUnlock={async () =>
          props.alwaysWrong ? { ok: false, reason: "wrong-secret" as const } : { ok: true }
        }
      />
    </div>
  )
}

const meta: Meta<typeof Harness> = {
  title: "Account/QuickUnlockPanel",
  component: Harness,
}
export default meta

type Story = StoryObj<typeof Harness>

export const Pin: Story = { args: { enrollments: [enrollment({ method: "pin" })] } }

export const Pattern: Story = { args: { enrollments: [enrollment({ method: "pattern" })] } }

export const Passkey: Story = {
  args: {
    enrollments: [enrollment({ method: "passkey", verifier: { credentialId: "cred-1" } })],
  },
}

/** Several methods, with the tab strip. */
export const EveryMethod: Story = {
  args: {
    enrollments: [
      enrollment({ method: "pin" }),
      enrollment({ method: "pattern" }),
      enrollment({ method: "passkey", verifier: { credentialId: "cred-1" } }),
    ],
  },
}

/** The warning that appears as the hard attempt cap approaches. */
export const AttemptsRunningOut: Story = {
  args: {
    enrollments: [enrollment({ method: "pin", failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS - 1 })],
  },
}

/** Disabled after the cap. Rendered, not hidden, so the reason is legible. */
export const LockedOut: Story = {
  args: {
    enrollments: [
      enrollment({ method: "pin", failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 1 }),
      enrollment({ method: "pattern" }),
    ],
  },
}

/** A rejected secret. */
export const WrongSecret: Story = {
  args: { enrollments: [enrollment({ method: "pin" })], alwaysWrong: true },
}
