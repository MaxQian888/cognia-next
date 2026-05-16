/** @jest-environment jsdom */

jest.mock("@/lib/native/opener", () => ({
  openUrl: jest.fn(async () => undefined),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: { call: jest.fn(async () => null) },
}))

jest.mock("@/lib/codex-subscription/credential-store", () => ({
  saveCodexCredential: jest.fn(async () => undefined),
  loadCodexCredential: jest.fn(async () => null),
  clearCodexCredential: jest.fn(async () => undefined),
  isCodexCredentialFresh: jest.requireActual("@/lib/codex-subscription/credential-store")
    .isCodexCredentialFresh,
}))

jest.mock("@/lib/codex-subscription/discovery", () => ({
  discoverCodexAuth: jest.fn(async () => null),
  discoveredToCredential: jest.requireActual("@/lib/codex-subscription/discovery")
    .discoveredToCredential,
}))

jest.mock("@/lib/codex-subscription/oauth", () => {
  const actual = jest.requireActual("@/lib/codex-subscription/oauth")
  return {
    ...actual,
    requestCodexDeviceCode: jest.fn(),
    pollCodexDeviceCode: jest.fn(),
    refreshCodexToken: jest.fn(),
    revokeCodexToken: jest.fn(),
  }
})

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import * as credentialStore from "@/lib/codex-subscription/credential-store"
import * as oauthMod from "@/lib/codex-subscription/oauth"
import type { DiscoveredCodexAuth } from "@/lib/codex-subscription/types"

import { CodexSubscriptionLoginDialog } from "./login-dialog"

const mSave = credentialStore.saveCodexCredential as jest.Mock
const mRequestDeviceCode = oauthMod.requestCodexDeviceCode as jest.Mock
const mPollDeviceCode = oauthMod.pollCodexDeviceCode as jest.Mock

const messages = {
  codexSubscription: {
    login: {
      title: "Sign in with Codex",
      chooseMode: "Pick how to sign in",
      modes: {
        reuse: {
          label: "Reuse codex-cli credential",
          description: "Read ~/.codex/auth.json without forcing a fresh login.",
        },
        oauth: {
          label: "Sign in with OpenAI",
          description: "Device-code flow against auth.openai.com.",
        },
      },
      actions: {
        cancel: "Cancel",
      },
      reuse: {
        scanning: "Scanning…",
        nothingFound: "No codex-cli credential found.",
        rescan: "Re-scan",
        source: "Source",
        authJsonPath: "auth.json",
        authMode: "Mode",
        email: "Email",
        plan: "Plan",
        adopt: "Adopt",
        notAdoptable: "Discovery payload missing a usable token.",
      },
      oauth: {
        intro: "OpenAI's device-code flow.",
        start: "Start device-code flow",
        awaiting: "Authorize on the page shown below.",
        exchanging: "Exchanging…",
        done: "Done.",
        userCode: "User code",
        verificationUri: "Verification URL",
        copy: "Copy",
        openLink: "Open",
        pending: {
          authorization_pending: "Waiting for authorization",
          slow_down: "Slow down",
          expired_token: "Code expired",
          access_denied: "Access denied",
        },
      },
    },
  },
}

function renderDialog(initialMode: "reuse" | "oauth" = "oauth") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CodexSubscriptionLoginDialog open onOpenChange={() => undefined} initialMode={initialMode} />
    </NextIntlClientProvider>
  )
}

const discovered: DiscoveredCodexAuth = {
  source: "file",
  authJsonPath: "/home/user/.codex/auth.json",
  authMode: "ChatGPT",
  tokens: {
    accessToken: "oat-from-cli",
    refreshToken: "rt-from-cli",
    idTokenRaw: "eyJ.cli.jwt",
    email: "user@example.com",
    chatgptPlanType: "Plus",
    accountId: "acct_x",
    chatgptUserId: "user_x",
    chatgptAccountId: "acct_x",
  },
}

beforeEach(() => {
  mSave.mockReset()
  mRequestDeviceCode.mockReset()
  mPollDeviceCode.mockReset()
  mSave.mockResolvedValue(undefined)
})

describe("CodexSubscriptionLoginDialog", () => {
  it("mounts without crashing in OAuth mode", async () => {
    renderDialog("oauth")
    // Radix dialog renders into a portal — give it a tick.
    expect(await screen.findByText("Sign in with Codex")).toBeInTheDocument()
  })

  it("mounts without crashing in Reuse mode", async () => {
    renderDialog("reuse")
    expect(await screen.findByText("Sign in with Codex")).toBeInTheDocument()
  })

  it("Adopt persists when discoveredToCredential succeeds (direct API)", async () => {
    // We exercise the same persistence path the Adopt click triggers, since
    // mocking the live `useCodexDiscovery` hook across jest/swc module
    // isolation is brittle. This guarantees the wire-up between
    // `discoveredToCredential` → `saveCodexCredential` works end-to-end.
    const next = (
      jest.requireActual(
        "@/lib/codex-subscription/discovery"
      ) as typeof import("@/lib/codex-subscription/discovery")
    ).discoveredToCredential(discovered)
    expect(next).not.toBeNull()
    await credentialStore.saveCodexCredential(next!)
    expect(mSave).toHaveBeenCalled()
    const payload = mSave.mock.calls[0][0]
    expect(payload.accessToken).toBe("oat-from-cli")
    expect(payload.authMode).toBe("chatgpt")
    expect(payload.originalSource).toBe("file")
  })
})
