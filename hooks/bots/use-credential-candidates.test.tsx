/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { IntegrationAccount } from "@/types/plugin/plugin-integration"

let liveValue: unknown
let lastRead: (() => unknown) | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (read: () => unknown) => {
    lastRead = read
    return liveValue
  },
}))

const listAllIntegrationAccounts = jest.fn(async () => [] as IntegrationAccount[])
const listAdapterInstances = jest.fn(async () => [] as AdapterInstanceRow[])

jest.mock("@/lib/db/integrations", () => ({
  listAllIntegrationAccounts: () => listAllIntegrationAccounts(),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstances: () => listAdapterInstances(),
}))

import { useCredentialCandidates } from "./use-credential-candidates"

const ACCOUNT = {
  id: "iacc_1",
  integrationId: "github",
  label: "Octocat",
  enabled: true,
} as IntegrationAccount

const ADAPTER = {
  id: "adp_1",
  type: "slack",
  displayName: "Ops Slack",
  enabled: true,
} as AdapterInstanceRow

beforeEach(() => {
  liveValue = undefined
  lastRead = undefined
  listAllIntegrationAccounts.mockClear().mockResolvedValue([])
  listAdapterInstances.mockClear().mockResolvedValue([])
})

describe("useCredentialCandidates", () => {
  it("reads both tables once, not once per slot", async () => {
    // A Bot with five slots would otherwise open ten Dexie queries on every
    // live-query tick, each returning the same two tables.
    renderHook(() => useCredentialCandidates())
    await lastRead?.()
    expect(listAllIntegrationAccounts).toHaveBeenCalledTimes(1)
    expect(listAdapterInstances).toHaveBeenCalledTimes(1)
  })

  it("narrows per slot from the one pair of reads", () => {
    liveValue = { accounts: [ACCOUNT], adapters: [ADAPTER] }
    const { result } = renderHook(() => useCredentialCandidates())
    expect(result.current.forSlot({ id: "gh", integration: "github" })).toEqual([
      expect.objectContaining({ value: "iacc_1", kind: "integration-account" }),
    ])
    expect(result.current.forSlot({ id: "im", integration: "slack" })).toEqual([
      expect.objectContaining({ value: "adp_1", kind: "adapter" }),
    ])
  })

  it("answers an empty list while loading rather than throwing", () => {
    const { result } = renderHook(() => useCredentialCandidates())
    expect(result.current.loading).toBe(true)
    expect(result.current.forSlot({ id: "gh" })).toEqual([])
  })
})
