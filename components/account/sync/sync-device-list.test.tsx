/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/account-sync/registry-sync", () => ({
  ...jest.requireActual("@/lib/account-sync/registry-sync"),
  currentKeyChain: jest.fn(async () => new Map()),
}))
jest.mock("@/lib/account-sync/device-names", () => ({ deviceNames: jest.fn() }))
jest.mock("@/lib/account-sync/enrollment/manage", () => ({
  revokeDevice: jest.fn(async () => ({})),
  rotateKeys: jest.fn(async () => ({})),
  prepareRecoveryKey: jest.fn(),
  commitRecoveryKey: jest.fn(async () => ({})),
}))
jest.mock("./recovery-key-setup", () => ({
  RecoveryKeySetup: ({ onConfirmed }: { onConfirmed: () => void }) => (
    <button onClick={onConfirmed}>confirm-new-key</button>
  ),
}))

import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { toast } from "sonner"

import { toBase64Url, type FoldedRegistry } from "@cognia/sync-protocol"

import type { DeviceKeys } from "@/lib/account-sync/crypto"
import { deviceNames } from "@/lib/account-sync/device-names"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import {
  commitRecoveryKey,
  prepareRecoveryKey,
  revokeDevice,
  rotateKeys,
} from "@/lib/account-sync/enrollment/manage"
import { currentKeyChain } from "@/lib/account-sync/registry-sync"

import { SyncDeviceList } from "./sync-device-list"

const context = {} as AccountSyncContext
const me = { deviceId: "dev_A", signPub: "SA" } as DeviceKeys
const entry = (deviceId: string, addedSeq: number, extra: object) => ({
  deviceId,
  platform: "desktop",
  signPub: `S${deviceId}`,
  encPub: `E${deviceId}`,
  nameCt: { epoch: 1, nonce: "n", ct: "c" },
  status: "active",
  addedSeq,
  addedVia: "genesis",
  addedBy: null,
  revokedSeq: null,
  revokedBy: null,
  ...extra,
})
const registry = {
  state: {
    spaceId: "s",
    genesisHash: "g",
    head: { seq: 2, hash: toBase64Url(new Uint8Array(32)) },
    epoch: 1,
    keyCommits: {},
    prevWraps: {},
    recovery: { signPub: "R", encPub: "R" },
    devices: {
      dev_A: entry("dev_A", 0, {}),
      dev_B: entry("dev_B", 1, { platform: "mobile", addedVia: "approval", addedBy: "dev_A" }),
      dev_C: entry("dev_C", 2, { status: "revoked" }),
    },
    usedKeys: [],
    pendingRecoveryRotate: null,
  },
  entries: [],
} as unknown as FoldedRegistry

async function renderList() {
  const onChanged = jest.fn()
  await act(async () => {
    render(
      <SyncDeviceList
        context={context}
        device={me}
        registry={registry}
        account="ada"
        onChanged={onChanged}
      />
    )
  })
  return onChanged
}

beforeEach(() => {
  jest.mocked(deviceNames).mockResolvedValue(
    new Map([
      ["dev_A", "MacBook"],
      ["dev_B", null],
    ])
  )
})

describe("SyncDeviceList", () => {
  it("lists the active devices with their names, and this device first", async () => {
    await renderList()
    const rows = screen.getAllByTestId("account-sync-device")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("MacBook")
    expect(rows[0]).toHaveTextContent("devices.thisDevice")
    expect(rows[1]).toHaveTextContent("devices.unnamed")
    expect(rows[1]).toHaveTextContent("devices.addedVia.approval(MacBook)")
    expect(within(rows[0]!).queryByTestId("account-sync-device-remove")).toBeNull()
    expect(screen.getByTestId("account-sync-fingerprint")).toHaveTextContent("0000 0000 0000 0000")
    expect(currentKeyChain).toHaveBeenCalled()
  })

  it("removes another device after a confirmation", async () => {
    const onChanged = await renderList()
    fireEvent.click(screen.getByTestId("account-sync-device-remove"))
    await act(async () =>
      fireEvent.click(await screen.findByTestId("account-sync-device-remove-confirm"))
    )
    expect(revokeDevice).toHaveBeenCalledWith(context, me, "dev_B")
    expect(toast.success).toHaveBeenCalledWith("devices.removed(devices.unnamed)")
    expect(onChanged).toHaveBeenCalled()
  })

  it("rotates the keys and replaces the recovery key", async () => {
    const onChanged = await renderList()
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-rotate")))
    expect(rotateKeys).toHaveBeenCalledWith(context, me)
    const prepared = { recoveryKeyText: "NEW", recoveryKey: new Uint8Array(1) }
    jest.mocked(prepareRecoveryKey).mockResolvedValue(prepared as never)
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-replace-recovery")))
    await act(async () => fireEvent.click(screen.getByText("confirm-new-key")))
    expect(commitRecoveryKey).toHaveBeenCalledWith(context, me, prepared)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it("says when this device cannot open its keys, and explains a failed change", async () => {
    jest.mocked(currentKeyChain).mockRejectedValueOnce(new Error("no envelope"))
    await renderList()
    expect(screen.getByRole("alert")).toHaveTextContent("devices.keysUnavailable")
    jest.mocked(rotateKeys).mockRejectedValueOnce(new Error("offline"))
    await act(async () => fireEvent.click(screen.getByTestId("account-sync-rotate")))
    expect(toast.error).toHaveBeenCalledWith("errors.generic(offline)")
  })
})
