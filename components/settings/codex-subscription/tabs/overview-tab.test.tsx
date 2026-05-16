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
  discoveredToCredential: jest.requireActual("@/lib/codex-subscription/discovery")
    .discoveredToCredential,
}))

import { render, screen, waitFor } from "@testing-library/react"

import * as credentialStore from "@/lib/codex-subscription/credential-store"
import * as discoveryMod from "@/lib/codex-subscription/discovery"

import { CodexSubscriptionOverviewTab } from "./overview-tab"

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

describe("CodexSubscriptionOverviewTab", () => {
  it("renders without crashing when both keyring + discovery are empty", async () => {
    const { container } = render(<CodexSubscriptionOverviewTab />)
    await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(0))
    // Signed-out state surfaces a CTA button.
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0)
  })

  // Signed-in flows (chatgpt vs api_key credential rendering) are exercised
  // by the hook tests in lib/codex-subscription/hooks.test.ts — we keep this
  // file thin to avoid the jest/swc module-isolation pitfalls that bite the
  // useEffect → state-update → re-render chain when hooks run live.
})
