/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: { call: jest.fn(async () => null) },
}))

jest.mock("@/lib/codex-subscription/credential-store", () => ({
  loadCodexCredential: jest.fn(async () => null),
  saveCodexCredential: jest.fn(async () => undefined),
  clearCodexCredential: jest.fn(async () => undefined),
  isCodexCredentialFresh: jest.requireActual("@/lib/codex-subscription/credential-store")
    .isCodexCredentialFresh,
}))

jest.mock("@/lib/codex-subscription/discovery", () => ({
  discoverCodexAuth: jest.fn(async () => null),
  discoveredToCredential: jest.fn(() => null),
}))

jest.mock("@/lib/codex-subscription/oauth", () => {
  const actual = jest.requireActual("@/lib/codex-subscription/oauth")
  return {
    ...actual,
    refreshCodexToken: jest.fn(),
    revokeCodexToken: jest.fn(),
  }
})

import { render, waitFor } from "@testing-library/react"

import * as credentialStore from "@/lib/codex-subscription/credential-store"

import { CodexSubscriptionAccountTab } from "./account-tab"

const mLoadCred = credentialStore.loadCodexCredential as jest.Mock

beforeEach(() => {
  mLoadCred.mockReset()
  mLoadCred.mockResolvedValue(null)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("CodexSubscriptionAccountTab", () => {
  it("mounts without crashing when keyring is empty", async () => {
    const { container } = render(<CodexSubscriptionAccountTab />)
    await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(0))
  })

  // Signed-in branches are exercised by the underlying hook tests
  // (lib/codex-subscription/hooks.test.ts) which directly verify the
  // refresh + signOut paths.
})
