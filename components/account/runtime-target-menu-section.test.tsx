import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { RuntimeTargetRecord } from "@/lib/runtime/target-registry"
import { RuntimeTargetMenuSection } from "./runtime-target-menu-section"

const switchCompanion = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/companion/host-orchestration", () => ({
  switchCompanionHost: (...args: unknown[]) => switchCompanion(...args),
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      heading: "Runtime target",
      thisBrowser: "This browser",
      legacyMixed: "Legacy mixed",
      active: "Active",
      loadFailed: "Could not load targets.",
      switchFailed: "Could not switch targets.",
      addHost: "Add host",
      removeHost: "Remove host",
      removeConfirmTitle: "Remove this host?",
      removeConfirm: "The Host must confirm revocation.",
      removeConfirmAction: "Remove Host",
      fallbackTitle: "Choose a replacement Host",
      fallbackDescription: "Pick the next Host.",
      fallbackField: "Replacement Host",
      cancel: "Cancel",
    })[key] ?? key,
}))

jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({
    target: { id: "web-standalone", kind: "standalone", platform: "web" },
  }),
}))

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "acct_web" }),
}))

const standalone: RuntimeTargetRecord = {
  accountId: "acct_web",
  id: "web-standalone",
  kind: "standalone",
  label: "This browser",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
}
const companion: RuntimeTargetRecord = {
  ...standalone,
  id: "companion-studio",
  kind: "companion",
  hostKind: "desktop",
  label: "Studio Mac",
  credentialRef: "companion:companion-studio:device-jwt",
}

beforeEach(() => {
  switchCompanion.mockClear()
})

it("renders all saved targets and switches through the shared runtime controller", async () => {
  const onSwitch = jest.fn(async () => companion)
  const onSwitched = jest.fn()
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion]}
      activeTargetIdOverride="web-standalone"
      onSwitchOverride={onSwitch}
      onSwitched={onSwitched}
    />
  )

  expect(screen.getByText("This browser")).toBeInTheDocument()
  expect(screen.getByText("Studio Mac")).toBeInTheDocument()
  expect(screen.getByTestId("runtime-target-web-standalone")).toBeDisabled()

  fireEvent.click(screen.getByTestId("runtime-target-companion-studio"))

  await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("acct_web", "companion-studio"))
  expect(onSwitched).toHaveBeenCalled()
})

it("keeps the menu open and explains a failed target switch", async () => {
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion]}
      activeTargetIdOverride="web-standalone"
      onSwitchOverride={async () => {
        throw new Error("Vault must be unlocked.")
      }}
    />
  )

  fireEvent.click(screen.getByTestId("runtime-target-companion-studio"))
  expect(await screen.findByRole("alert")).toHaveTextContent("Vault must be unlocked.")
})

it("switches a Companion target through the canonical Host orchestrator", async () => {
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion]}
      activeTargetIdOverride="web-standalone"
    />
  )

  fireEvent.click(screen.getByTestId("runtime-target-companion-studio"))

  await waitFor(() =>
    expect(switchCompanion).toHaveBeenCalledWith({
      accountId: "acct_web",
      hostId: "companion-studio",
      platform: "web",
    })
  )
})

it("opens add mode and removes only after a themed confirmation", async () => {
  const user = userEvent.setup()
  const onRemove = jest.fn().mockResolvedValue(undefined)
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion]}
      activeTargetIdOverride="web-standalone"
      onRemoveOverride={onRemove}
    />
  )

  fireEvent.click(screen.getByText("Add host"))
  expect(push).toHaveBeenCalledWith("/pair?mode=add")
  await user.click(screen.getByTestId("runtime-target-remove-companion-studio"))
  const dialog = await screen.findByRole("alertdialog", { name: "Remove this host?" })
  expect(onRemove).not.toHaveBeenCalled()
  await user.click(within(dialog).getByRole("button", { name: "Remove Host" }))
  await waitFor(() =>
    expect(onRemove).toHaveBeenCalledWith({
      accountId: "acct_web",
      hostId: "companion-studio",
      platform: "web",
    })
  )
})

it("keeps the Host when the confirmation is cancelled", async () => {
  const user = userEvent.setup()
  const onRemove = jest.fn().mockResolvedValue(undefined)
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion]}
      activeTargetIdOverride="web-standalone"
      onRemoveOverride={onRemove}
    />
  )
  const trigger = screen.getByTestId("runtime-target-remove-companion-studio")
  await user.click(trigger)
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" })
  )
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  expect(onRemove).not.toHaveBeenCalled()
  await waitFor(() => expect(trigger).toHaveFocus())
})

it("asks for a replacement from the saved Hosts when removing the active one", async () => {
  const user = userEvent.setup()
  const office: RuntimeTargetRecord = { ...companion, id: "companion-office", label: "Office PC" }
  const onRemove = jest.fn().mockResolvedValue(undefined)
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion, office]}
      activeTargetIdOverride="companion-studio"
      onRemoveOverride={onRemove}
    />
  )

  await user.click(screen.getByTestId("runtime-target-remove-companion-studio"))
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove Host" })
  )
  const chooser = await screen.findByRole("dialog", { name: "Choose a replacement Host" })
  // Only the other Companion Hosts are offered — never the one being removed.
  expect(within(chooser).getByRole("combobox", { name: "Replacement Host" })).toHaveTextContent(
    "Office PC"
  )
  await user.click(within(chooser).getByRole("button", { name: "Remove Host" }))
  await waitFor(() =>
    expect(onRemove).toHaveBeenCalledWith({
      accountId: "acct_web",
      hostId: "companion-studio",
      platform: "web",
      fallbackHostId: "companion-office",
    })
  )
})

it("does not remove the active Host when the replacement choice is cancelled", async () => {
  const user = userEvent.setup()
  const office: RuntimeTargetRecord = { ...companion, id: "companion-office", label: "Office PC" }
  const onRemove = jest.fn().mockResolvedValue(undefined)
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion, office]}
      activeTargetIdOverride="companion-studio"
      onRemoveOverride={onRemove}
    />
  )
  await user.click(screen.getByTestId("runtime-target-remove-companion-studio"))
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove Host" })
  )
  const chooser = await screen.findByRole("dialog", { name: "Choose a replacement Host" })
  await user.click(within(chooser).getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(onRemove).not.toHaveBeenCalled()
})

it("hides itself under requireCompanion until a Host is actually paired", () => {
  // Every web account owns a standalone target, so without this the runtime
  // connection popover would show a one-row list of the target the user is
  // already on, next to a "Connect Host" button.
  const { container, rerender } = render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone]}
      activeTargetIdOverride="web-standalone"
      requireCompanion
    />
  )
  expect(container).toBeEmptyDOMElement()

  rerender(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion]}
      activeTargetIdOverride="web-standalone"
      requireCompanion
    />
  )
  expect(screen.getByTestId("runtime-target-menu")).toBeInTheDocument()
  expect(screen.getByText("Studio Mac")).toBeInTheDocument()
})

it("drops its own Add host row when the caller already offers one", () => {
  render(
    <RuntimeTargetMenuSection
      accountIdOverride="acct_web"
      targetsOverride={[standalone, companion]}
      activeTargetIdOverride="web-standalone"
      showAddHost={false}
      className="border-t"
    />
  )
  expect(screen.queryByText("Add host")).not.toBeInTheDocument()
  // The divider rides on the root, so a self-hidden section leaves no rule
  // hanging over nothing.
  expect(screen.getByTestId("runtime-target-menu")).toHaveClass("border-t")
})
