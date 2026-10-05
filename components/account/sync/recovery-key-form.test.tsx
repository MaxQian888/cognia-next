/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/account-sync/enrollment/recover", () => ({ recoverWithKey: jest.fn() }))
jest.mock("@/lib/account-sync/enrollment/manage", () => ({
  prepareRecoveryKey: jest.fn(),
  commitRecoveryKey: jest.fn(),
}))
jest.mock("@/lib/account-sync/enrollment/platform", () => ({
  currentDevicePlatform: () => "mobile",
  suggestDeviceName: () => "iPhone",
}))
jest.mock("./recovery-key-setup", () => ({
  RecoveryKeySetup: ({ onConfirmed }: { onConfirmed: () => void }) => (
    <button onClick={onConfirmed}>confirm-new-key</button>
  ),
}))

import { act, fireEvent, render, screen } from "@testing-library/react"

import { AccountSyncCryptoError } from "@/lib/account-sync/crypto"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { commitRecoveryKey, prepareRecoveryKey } from "@/lib/account-sync/enrollment/manage"
import { recoverWithKey } from "@/lib/account-sync/enrollment/recover"

import { RecoveryKeyForm } from "./recovery-key-form"

const VALID = "0123-4567-89AB-CDEF-GHJK-MNPQ-RW"
const device = { deviceId: "dev_P" }
const context = {
  vault: { loadDeviceKeys: jest.fn(async () => device) },
} as unknown as AccountSyncContext

function setup() {
  const onDone = jest.fn()
  const onBack = jest.fn()
  render(<RecoveryKeyForm context={context} account="ada" onDone={onDone} onBack={onBack} />)
  return { onDone, onBack }
}

async function submit(value: string) {
  fireEvent.change(screen.getByTestId("account-sync-recovery-key"), { target: { value } })
  await act(async () => fireEvent.click(screen.getByTestId("account-sync-recover-submit")))
}

describe("RecoveryKeyForm", () => {
  it("refuses something that is not a recovery key before asking anything", async () => {
    setup()
    await submit("hello")
    expect(screen.getByRole("alert")).toHaveTextContent("recover.invalid")
    expect(recoverWithKey).not.toHaveBeenCalled()
  })

  it("explains a key of another account", async () => {
    jest
      .mocked(recoverWithKey)
      .mockRejectedValueOnce(new AccountSyncCryptoError("recovery_mismatch", "x"))
    setup()
    await submit(VALID)
    expect(screen.getByRole("alert")).toHaveTextContent("recover.mismatch")
  })

  it("adds the device, then lets the person replace the key later", async () => {
    jest.mocked(recoverWithKey).mockResolvedValue({} as never)
    const { onDone } = setup()
    await submit(VALID)
    expect(recoverWithKey).toHaveBeenCalledWith(context, VALID, {
      name: "iPhone",
      platform: "mobile",
    })
    expect(screen.getByTestId("account-sync-recover")).toHaveAttribute(
      "data-phase",
      "offer-replace"
    )
    fireEvent.click(screen.getByTestId("account-sync-recover-later"))
    expect(onDone).toHaveBeenCalled()
  })

  it("replaces the key right away", async () => {
    jest.mocked(recoverWithKey).mockResolvedValue({} as never)
    const prepared = { recoveryKeyText: "NEW" }
    jest.mocked(prepareRecoveryKey).mockResolvedValue(prepared as never)
    jest.mocked(commitRecoveryKey).mockResolvedValue({} as never)
    const { onDone } = setup()
    await submit(VALID)
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-recover-replace")))
    await act(async () => fireEvent.click(screen.getByText("confirm-new-key")))
    expect(commitRecoveryKey).toHaveBeenCalledWith(context, device, prepared)
    expect(onDone).toHaveBeenCalled()
  })

  it("goes back", () => {
    const { onBack } = setup()
    fireEvent.click(screen.getByText("recover.back"))
    expect(onBack).toHaveBeenCalled()
  })
})
