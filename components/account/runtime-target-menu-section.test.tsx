import { fireEvent, render, screen, waitFor } from "@testing-library/react"

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
      removeConfirm: "Remove this host?",
      fallbackPrompt: "Fallback host ({choices})",
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

it("opens add mode and removes only after confirmation", async () => {
  jest.spyOn(window, "confirm").mockReturnValueOnce(true)
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
  fireEvent.click(screen.getByTestId("runtime-target-remove-companion-studio"))
  await waitFor(() =>
    expect(onRemove).toHaveBeenCalledWith({
      accountId: "acct_web",
      hostId: "companion-studio",
      platform: "web",
    })
  )
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
