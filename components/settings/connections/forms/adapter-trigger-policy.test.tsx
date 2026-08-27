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

// The draft is keyed on the STORED POLICY, not on `updatedAt`. Every write to
// the adapter row bumps `updatedAt` — another settings card saving, a
// `lastMissingScopes` update, a companion sync — and remounting on those threw
// away an in-progress edit across twelve controls with nothing to show for it.
it("keeps an in-progress edit when an unrelated field on the row changes", async () => {
  const user = userEvent.setup()
  const { rerender } = render(<AdapterTriggerPolicy adapterId="a" />)

  await user.click(screen.getByTestId("adapter-trigger-rule-self-mention-switch"))
  expect(screen.getByTestId("adapter-trigger-rule-self-mention-switch")).toBeChecked()

  // Something else wrote the row: `updatedAt` moves, the policy does not.
  Object.assign(mockRow, { updatedAt: 2, lastMissingScopes: ["channels:history"] })
  rerender(<AdapterTriggerPolicy adapterId="a" />)

  expect(screen.getByTestId("adapter-trigger-rule-self-mention-switch")).toBeChecked()
})

// ...but a real change to the thing being drafted still re-seeds, which is
// also what makes this card's own save land back in the editor.
it("re-seeds when the stored policy itself changes underneath", async () => {
  const user = userEvent.setup()
  const { rerender } = render(<AdapterTriggerPolicy adapterId="a" />)

  await user.click(screen.getByTestId("adapter-trigger-rule-self-mention-switch"))
  expect(screen.getByTestId("adapter-trigger-rule-self-mention-switch")).toBeChecked()

  Object.assign(mockRow, {
    updatedAt: 3,
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
  })
  rerender(<AdapterTriggerPolicy adapterId="a" />)

  expect(screen.getByTestId("adapter-trigger-rule-self-mention-switch")).not.toBeChecked()
})
