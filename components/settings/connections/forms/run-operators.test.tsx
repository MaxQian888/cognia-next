/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    t.has = () => true
    return t
  },
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { RunOperators, parseOperatorIds } from "./run-operators"

const ADAPTER_ID = "lark-ops-1"

async function seedAdapter(settings: Record<string, unknown> = {}) {
  await getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type: "lark",
    displayName: "Ops Bot",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    settings,
  } as never)
}

describe("parseOperatorIds", () => {
  it("splits on commas and whitespace, trims, and de-duplicates in order", () => {
    expect(parseOperatorIds("ou_a, ou_b\n ou_c")).toEqual(["ou_a", "ou_b", "ou_c"])
    expect(parseOperatorIds("ou_a, ou_a , ou_b")).toEqual(["ou_a", "ou_b"])
    expect(parseOperatorIds("   ")).toEqual([])
    expect(parseOperatorIds("")).toEqual([])
  })
})

describe("RunOperators", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("persists a parsed operator list on blur", async () => {
    await seedAdapter()
    const user = userEvent.setup({ delay: null })
    render(<RunOperators adapterId={ADAPTER_ID} />)

    const input = await screen.findByTestId("run-operators-input")
    await waitFor(() => expect(input).toBeEnabled())
    await user.type(input, "ou_a, ou_b")
    await user.tab()

    await waitFor(async () => {
      const row = await getDb().adapterInstances.get(ADAPTER_ID)
      expect(row?.settings?.runOperatorUserIds).toEqual(["ou_a", "ou_b"])
    })
  })

  it("clears the field to undefined rather than storing an empty array", async () => {
    await seedAdapter({ runOperatorUserIds: ["ou_a"] })
    const user = userEvent.setup({ delay: null })
    render(<RunOperators adapterId={ADAPTER_ID} />)

    const input = await screen.findByTestId("run-operators-input")
    await waitFor(() => expect(input).toHaveValue("ou_a"))
    await user.clear(input)
    await user.tab()

    await waitFor(async () => {
      const row = await getDb().adapterInstances.get(ADAPTER_ID)
      expect(row?.settings?.runOperatorUserIds).toBeUndefined()
    })
  })

  it("renders the stored list and its count", async () => {
    await seedAdapter({ runOperatorUserIds: ["ou_a", "ou_b"] })
    render(<RunOperators adapterId={ADAPTER_ID} />)

    await waitFor(() => expect(screen.getByTestId("run-operators-input")).toHaveValue("ou_a, ou_b"))
    expect(screen.getByTestId("run-operators-count").textContent).toContain('"count":2')
  })

  it("says nobody but the requester can act when the list is empty", async () => {
    await seedAdapter()
    render(<RunOperators adapterId={ADAPTER_ID} />)

    await waitFor(() => expect(screen.getByTestId("run-operators-count").textContent).toBe("empty"))
  })

  it("ignores a non-array stored value instead of crashing", async () => {
    await seedAdapter({ runOperatorUserIds: "ou_a" })
    render(<RunOperators adapterId={ADAPTER_ID} />)

    await waitFor(() => expect(screen.getByTestId("run-operators-input")).toHaveValue(""))
  })
})
