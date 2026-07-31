import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { RuntimeTargetRecord } from "@/lib/runtime/target-registry"
import { RuntimeTargetMenuSection } from "./runtime-target-menu-section"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      heading: "Runtime target",
      thisBrowser: "This browser",
      legacyMixed: "Legacy mixed",
      active: "Active",
      loadFailed: "Could not load targets.",
      switchFailed: "Could not switch targets.",
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
