import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { defaultTriggerPolicyFor } from "@/types/connectors/policy"

import { AdapterTriggerPolicy } from "./adapter-trigger-policy"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const mockRow: Record<string, unknown> = {}
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockRow }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
const mockUpdateAdapterConfigSection = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterConfigSection: (...args: unknown[]) => mockUpdateAdapterConfigSection(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
  Object.assign(mockRow, {
    id: "a",
    type: "telegram",
    updatedAt: 1,
    // A bot created before the default profiles covered both chat scopes: its
    // stored policy answers direct messages and ignores every group @-mention.
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: true,
    },
  })
})

it("seeds the editor from the stored policy", () => {
  render(<AdapterTriggerPolicy adapterId="a" />)
  expect(screen.getByTestId("adapter-trigger-rule-private-default-switch")).toBeChecked()
  expect(screen.getByTestId("adapter-trigger-rule-self-mention-switch")).not.toBeChecked()
  // The whole point of the card: the operator can now see WHY the bot ignores
  // the group it is in.
  expect(screen.getByTestId("adapter-trigger-gap-group-mention")).toBeInTheDocument()
})

it("persists the whole policy under its own audited section", async () => {
  const user = userEvent.setup()
  render(<AdapterTriggerPolicy adapterId="a" />)

  await user.click(screen.getByTestId("adapter-trigger-rule-self-mention-switch"))
  await user.click(screen.getByTestId("adapter-trigger-save"))

  expect(mockUpdateAdapterConfigSection).toHaveBeenCalledWith(
    "a",
    "trigger",
    {
      trigger: {
        rules: [{ kind: "private-default" }, { kind: "self-mention" }],
        blockers: [],
        storeUnmatchedInDraftMode: true,
      },
    },
    "settings.adapter.trigger"
  )
})

// Edits are a draft, not per-keystroke writes: a half-built policy must never
// route live traffic.
it("writes nothing until the operator saves", async () => {
  const user = userEvent.setup()
  render(<AdapterTriggerPolicy adapterId="a" />)

  await user.click(screen.getByTestId("adapter-trigger-rule-self-mention-switch"))
  expect(mockUpdateAdapterConfigSection).not.toHaveBeenCalled()
})

it("drops the draft on cancel", async () => {
  const user = userEvent.setup()
  render(<AdapterTriggerPolicy adapterId="a" />)

  await user.click(screen.getByTestId("adapter-trigger-rule-self-mention-switch"))
  await user.click(screen.getByTestId("adapter-trigger-cancel"))

  expect(screen.getByTestId("adapter-trigger-rule-self-mention-switch")).not.toBeChecked()
})

it("repairs a half-policy back to the platform's recommended profile", async () => {
  const user = userEvent.setup()
  render(<AdapterTriggerPolicy adapterId="a" />)

  await user.click(screen.getByTestId("adapter-trigger-restore-defaults"))
  await user.click(screen.getByTestId("adapter-trigger-save"))

  expect(mockUpdateAdapterConfigSection).toHaveBeenCalledWith(
    "a",
    "trigger",
    { trigger: defaultTriggerPolicyFor("telegram") },
    "settings.adapter.trigger"
  )
})
