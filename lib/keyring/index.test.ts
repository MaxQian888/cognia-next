/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

import { invoke } from "@tauri-apps/api/core"

import { clearSecret, getSecret, setSecret } from "./index"

const invokeMock = invoke as jest.Mock
const ref = { namespace: "tests", key: "token" }

beforeEach(() => {
  invokeMock.mockReset()
})

describe("desktop secret-store IPC", () => {
  it("uses the canonical get command", async () => {
    invokeMock.mockResolvedValue("secret")
    await expect(getSecret(ref)).resolves.toBe("secret")
    expect(invokeMock).toHaveBeenCalledWith("secret_store_get", { input: ref })
  })

  it("uses canonical set and delete commands", async () => {
    invokeMock.mockResolvedValue(undefined)
    await setSecret(ref, "secret")
    await clearSecret(ref)
    expect(invokeMock.mock.calls).toEqual([
      ["secret_store_set", { input: { ...ref, value: "secret" } }],
      ["secret_store_delete", { input: ref }],
    ])
  })

  it("rejects an empty value before invoking the host", async () => {
    await expect(setSecret(ref, "")).rejects.toThrow("must not be empty")
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
