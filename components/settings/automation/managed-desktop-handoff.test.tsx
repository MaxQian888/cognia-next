import { selectOption } from "@/lib/testing/select-option"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: jest.fn((selector) => selector({ locked: false, unlockedAccountId: "owner" })),
}))
jest.mock("@/lib/automation/managed-desktop-handoff-client", () => ({
  managedDesktopHandoffClient: { deliveries: jest.fn(), prepare: jest.fn() },
  managedDesktopHandoffErrorKey: jest.fn(() => "prepareFailed"),
}))
import { useAccountStore } from "@/stores/account/account-store"
import { managedDesktopHandoffClient } from "@/lib/automation/managed-desktop-handoff-client"
import type {
  ManagedDesktopConfigSummary,
  ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"
import { ManagedDesktopHandoff } from "./managed-desktop-handoff"

const api = managedDesktopHandoffClient as jest.Mocked<typeof managedDesktopHandoffClient>
const t = messages.handoff
const target: ManagedDesktopTarget = { kind: "remote", hostId: "chosen-host" }
const config: ManagedDesktopConfigSummary = {
  id: "provider",
  ownerPrincipalId: "owner",
  hostId: "host",
  enabled: true,
  canCreate: false,
  canPrepareTemplate: false,
  qualification: "unqualified",
  isolationTier: "vm",
  egressTier: "off",
  egressEnforcement: "unverified",
  maxConcurrent: 2,
  maxLifetimeSeconds: 3600,
  idleTimeoutSeconds: 600,
  cpuCount: 2,
  memoryMb: 4096,
}
const delivery = {
  id: "delivery",
  revision: 8,
  commit: "a".repeat(40),
  branch: "task",
  modes: ["commit", "bundle"] as ("commit" | "bundle")[],
  createdAt: 1,
}
const proposal = {
  id: "proposal",
  deliveryId: delivery.id,
  deliveryRevision: 8,
  mode: "commit" as const,
  commit: delivery.commit,
  expiresAt: 2_000_000_000_000,
  executionEnabled: false as const,
  dormantReason: "managed_desktop_handoff_requires_results_qualification" as const,
  quote: {
    id: "quote",
    providerConfigId: config.id,
    lifetimeSeconds: 3600,
    expiresAt: 2_000_000_000_000,
    currency: "USD",
    hourlyRateMicros: 165600,
    maximumComputeCostMicros: 165600,
    priceObservedAt: 1,
    cpuCount: 2,
    memoryMb: 4096,
    configRevision: 1,
  },
}
function panel(selectedTarget = target) {
  return (
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: messages } }}>
      <ManagedDesktopHandoff target={selectedTarget} config={config} />
    </NextIntlClientProvider>
  )
}
async function fill() {
  fireEvent.click(screen.getByRole("button", { name: t.load }))
  await screen.findByLabelText(t.delivery)
  await selectOption(screen.getByLabelText(t.delivery), delivery.id)
  fireEvent.change(screen.getByLabelText(t.criteria), {
    target: { value: "Login works\nLogout works" },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({ locked: false, unlockedAccountId: "owner" })
  )
  api.deliveries.mockResolvedValue([delivery])
  api.prepare.mockResolvedValue(proposal)
})

test("mount labels all dormant axes and does not fetch, prepare or start acceptance", () => {
  render(panel())
  expect(screen.getByText(t.dormant)).toBeVisible()
  expect(screen.getByText(t.sourceScope)).toBeVisible()
  expect(screen.getByText(t.unsupported)).toBeVisible()
  expect(screen.getByRole("button", { name: t.start })).toBeDisabled()
  expect(api.deliveries).not.toHaveBeenCalled()
  expect(api.prepare).not.toHaveBeenCalled()
})

test("user prepares exact source, explicit files and argv on selected Host and sees bounded cost", async () => {
  render(panel())
  await fill()
  await selectOption(screen.getByLabelText(t.mode), "bundle")
  fireEvent.change(screen.getByLabelText(t.files), { target: { value: "acceptance/login.md" } })
  fireEvent.change(screen.getByLabelText(t.argv), { target: { value: '["npm","run","test"]' } })
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  expect(await screen.findByRole("status")).toHaveTextContent("USD 0.1656/hour")
  expect(screen.getByRole("status")).toHaveTextContent(
    "Maximum desktop compute within this deadline: USD 0.1656"
  )
  expect(screen.getByRole("status")).toHaveTextContent(delivery.commit)
  expect(api.prepare).toHaveBeenCalledWith(target, {
    deliveryId: delivery.id,
    deliveryRevision: 8,
    mode: "bundle",
    providerConfigId: config.id,
    lifetimeSeconds: 3600,
    criteria: ["Login works", "Logout works"],
    acceptanceFiles: ["acceptance/login.md"],
    argv: ["npm", "run", "test"],
  })
  expect(screen.getByRole("button", { name: t.start })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(t.criteria), { target: { value: "Different criterion" } })
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
})

test("invalid command or overlong deadline cannot prepare, while [] explicitly skips launch", async () => {
  render(panel())
  await fill()
  expect(screen.getByRole("button", { name: t.prepare })).toBeEnabled()
  fireEvent.change(screen.getByLabelText(t.argv), {
    target: { value: "npm run test && curl private" },
  })
  expect(screen.getByRole("button", { name: t.prepare })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(t.argv), {
    target: { value: '["sh","-c","echo private"]' },
  })
  expect(screen.getByRole("button", { name: t.prepare })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(t.argv), { target: { value: "[]" } })
  fireEvent.change(screen.getByLabelText(t.lifetime), { target: { value: "61" } })
  expect(screen.getByRole("button", { name: t.prepare })).toBeDisabled()
  expect(api.prepare).not.toHaveBeenCalled()
})

test("Host failure uses translated refusal and preserves disabled execution", async () => {
  api.prepare.mockRejectedValue(new Error("private source path"))
  render(panel())
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  expect(await screen.findByRole("alert")).toHaveTextContent(t.prepareFailed)
  expect(screen.queryByText("private source path")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: t.start })).toBeDisabled()
})

test("switching Host removes its source list and ignores a pending proposal", async () => {
  let resolve!: (value: typeof proposal) => void
  api.prepare.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const view = render(panel())
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  view.rerender(panel({ kind: "remote", hostId: "other-host" }))
  resolve(proposal)
  await waitFor(() => expect(screen.getByRole("button", { name: t.load })).toBeEnabled())
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.queryByLabelText(t.delivery)).not.toBeInTheDocument()
})

test("account change removes previously prepared private metadata", async () => {
  const view = render(panel())
  await fill()
  fireEvent.click(screen.getByRole("button", { name: t.prepare }))
  await screen.findByRole("status")
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({ locked: false, unlockedAccountId: "other" })
  )
  view.rerender(panel())
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.queryByLabelText(t.delivery)).not.toBeInTheDocument()
})
