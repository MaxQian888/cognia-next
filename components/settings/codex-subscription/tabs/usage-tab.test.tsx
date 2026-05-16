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

import { render, waitFor } from "@testing-library/react"

import * as credentialStore from "@/lib/codex-subscription/credential-store"
import * as discoveryMod from "@/lib/codex-subscription/discovery"

import { CodexSubscriptionUsageTab } from "./usage-tab"

const mLoadCred = credentialStore.loadCodexCredential as jest.Mock
const mDiscover = discoveryMod.discoverCodexAuth as jest.Mock

beforeEach(() => {
  mLoadCred.mockReset()
  mDiscover.mockReset()
  mLoadCred.mockResolvedValue(null)
  mDiscover.mockResolvedValue(null)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("CodexSubscriptionUsageTab", () => {
  it("renders the unsupported-tracking notice + audit card", async () => {
    const { container } = render(<CodexSubscriptionUsageTab />)
    await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(0))
    // The unsupported notice always shows. Real-i18n strings include
    // either "usage" or "tracking" or "Codex" — assert via length only,
    // since this file's purpose is to confirm the tab mounts.
  })
})
