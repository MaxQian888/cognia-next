/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), info: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/account-sync/enrollment/first-device", () => ({
  prepareFirstDevice: jest.fn(),
  commitFirstDevice: jest.fn(),
}))
jest.mock("@/lib/account-sync/enrollment/platform", () => ({
  currentDevicePlatform: () => "desktop",
  suggestDeviceName: () => "Mac",
}))
jest.mock("./recovery-key-setup", () => ({
  RecoveryKeySetup: ({
    onConfirmed,
    onCancel,
    recoveryKeyText,
  }: {
    onConfirmed: () => void
    onCancel: () => void
    recoveryKeyText: string
  }) => (
    <div data-testid="setup-stub">
      {recoveryKeyText}
      <button onClick={onConfirmed}>confirm</button>
      <button onClick={onCancel}>cancel</button>
    </div>
  ),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"

import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { commitFirstDevice, prepareFirstDevice } from "@/lib/account-sync/enrollment/first-device"
import { AccountSyncVaultLockedError } from "@/lib/account-sync/vault-store"

import { FirstDeviceSetup } from "./first-device-setup"

const context = {} as AccountSyncContext
const prepared = { recoveryKeyText: "KEY-TEXT", recoveryKey: new Uint8Array([1, 2]) }

function setup() {
  const onDone = jest.fn()
  const onSpaceExists = jest.fn()
  render(
    <FirstDeviceSetup
      context={context}
      account="ada"
      onDone={onDone}
      onSpaceExists={onSpaceExists}
    />
  )
  return { onDone, onSpaceExists }
}

async function startAndConfirm() {
  await act(async () => fireEvent.click(screen.getByTestId("account-sync-setup-start")))
  await act(async () => fireEvent.click(screen.getByText("confirm")))
}

beforeEach(() => {
  jest.mocked(prepareFirstDevice).mockResolvedValue(prepared as never)
})

describe("FirstDeviceSetup", () => {
  it("prepares with the device name, gates on the recovery key, then creates the space", async () => {
    jest.mocked(commitFirstDevice).mockResolvedValue({ kind: "created" } as never)
    const { onDone } = setup()
    expect(screen.getByTestId("account-sync-device-name")).toHaveValue("Mac")
    fireEvent.change(screen.getByTestId("account-sync-device-name"), {
      target: { value: "Work Mac" },
    })
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-setup-start")))
    expect(prepareFirstDevice).toHaveBeenCalledWith(context, {
      name: "Work Mac",
      platform: "desktop",
    })
    expect(screen.getByTestId("setup-stub")).toHaveTextContent("KEY-TEXT")
    expect(commitFirstDevice).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByText("confirm")))
    expect(commitFirstDevice).toHaveBeenCalledWith(context, prepared)
    expect(onDone).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith("setup.done")
  })

  it("switches to joining when another device created the space first", async () => {
    jest.mocked(commitFirstDevice).mockResolvedValue({ kind: "space-exists" })
    const { onSpaceExists, onDone } = setup()
    await startAndConfirm()
    expect(onSpaceExists).toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("explains a failure", async () => {
    jest.mocked(prepareFirstDevice).mockRejectedValue(new AccountSyncVaultLockedError())
    setup()
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-setup-start")))
    expect(screen.getByRole("alert")).toHaveTextContent("errors.locked")
  })

  it("forgets the prepared key when cancelled", async () => {
    setup()
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-setup-start")))
    fireEvent.click(screen.getByText("cancel"))
    expect(prepared.recoveryKey.every((byte) => byte === 0)).toBe(true)
    expect(screen.getByTestId("account-sync-setup-start")).toBeInTheDocument()
  })
})
