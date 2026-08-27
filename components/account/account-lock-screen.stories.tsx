import type { Meta, StoryObj } from "@storybook/nextjs"

import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"
import { AccountUnlockError } from "@/lib/accounts/account-unlock-error"
import { publishUnlockStage } from "@/lib/accounts/unlock-progress"

import { AccountLockScreen } from "./account-lock-screen"

const verifier: PasswordVerifierRecord = {
  algorithm: "argon2id-v1",
  salt: "salt",
  hash: "hash",
  params: {},
}

function account(id: string, displayName: string): LocalAccountRecord {
  return { id, displayName, passwordVerifier: verifier, createdAt: 1, updatedAt: 1 }
}

const ALPHA = account("acct_alpha", "Max")
const BETA = account("acct_beta", "Work profile")

const never = () => new Promise<void>(() => {})

/** Walk the stage ladder on a schedule so the pending state is visible at rest. */
function scriptedUnlock(accountId: string) {
  return () =>
    new Promise<void>(() => {
      const script = ["verifying", "preparing-runtime", "opening-database", "activating"] as const
      script.forEach((stage, index) => {
        setTimeout(() => publishUnlockStage(accountId, stage), index * 2_000)
      })
    })
}

const meta = {
  title: "Account/AccountLockScreen",
  component: AccountLockScreen,
  parameters: { layout: "fullscreen" },
  args: {
    accounts: [ALPHA],
    activeAccountId: ALPHA.id,
    supportsRecoveryKey: false,
    onUnlock: async () => {},
    onRecoveryUnlock: async () => {},
  },
  decorators: [
    (Story) => (
      <main className="flex min-h-[520px] items-center justify-center bg-background px-4 text-foreground">
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof AccountLockScreen>

export default meta
type Story = StoryObj<typeof meta>

/** Desktop host at rest: keychain badge, no recovery entry point. */
export const Idle: Story = {}

/** Browser Vault runtime: recovery key is redeemable here. */
export const BrowserVault: Story = {
  args: { supportsRecoveryKey: true },
}

/** More than one local account — the picker chooses which one to unlock. */
export const MultipleAccounts: Story = {
  args: { accounts: [ALPHA, BETA] },
}

/** The fix for "nothing happens": spinner, changed label, live stage ladder. */
export const Unlocking: Story = {
  args: { onUnlock: scriptedUnlock(ALPHA.id) },
}

/** Same, on a Browser Vault runtime, which has one extra stage. */
export const UnlockingBrowserVault: Story = {
  args: { supportsRecoveryKey: true, onUnlock: scriptedUnlock(ALPHA.id) },
}

/** Past the slow threshold — still waiting, but the screen says so. */
export const Slow: Story = {
  args: { onUnlock: never, slowAfterMs: 200, stuckAfterMs: 10 * 60_000 },
}

/** Past the stuck threshold — the three things that actually help. */
export const Stuck: Story = {
  args: { onUnlock: never, slowAfterMs: 100, stuckAfterMs: 200 },
}

/** A rejected password, rendered from a translated code. */
export const WrongPassword: Story = {
  args: {
    onUnlock: async () => {
      throw new AccountUnlockError("invalid-password")
    },
  },
}

/** A desktop-created account opened in a browser: nameable, not a raw crypto error. */
export const NoVaultInThisBrowser: Story = {
  args: {
    supportsRecoveryKey: true,
    onUnlock: async () => {
      throw new AccountUnlockError("vault-not-provisioned")
    },
  },
}
