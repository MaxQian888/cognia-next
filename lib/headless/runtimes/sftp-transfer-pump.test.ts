/** @jest-environment node */
// Named `.test.ts` rather than the `.headless.test.ts` its four siblings use:
// check-colocated-tests matches `<stem>.test.ts` exactly, which is why those
// four sit in its baseline despite having tests.

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import { startSftpTransferPump } from "@/lib/sftp/transfer-queue"

const stop = jest.fn()
jest.mock("@/lib/sftp/transfer-queue", () => ({
  startSftpTransferPump: jest.fn(() => stop),
}))
const mockStart = startSftpTransferPump as jest.MockedFunction<typeof startSftpTransferPump>

function context(): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "local_acct_headless",
    bridge: {
      listen: async () => () => undefined,
      invoke: async () => null,
      respondMedia: async () => {},
    },
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => `translated:${key}`,
    log: jest.fn(),
  }
}

beforeAll(async () => {
  __resetHeadlessRuntimesForTesting()
  await import("./sftp-transfer-pump")
})

beforeEach(() => {
  jest.clearAllMocks()
})

it("drains the brain's own queue without waiting for an approval nobody is there to give", async () => {
  const result = await bootstrapHeadlessRuntimes(context())

  expect(result.failed).toEqual([])
  expect(result.started).toEqual(["sftp-transfer-pump"])
  // The interactive approval exists so a REMOTE device asks a human at the
  // host. The brain IS the host, and has no human to ask, so requiring one
  // would park every row with nobody able to release it. A paired device's
  // transfer is still gated on the way in, by ssh.files plus the approval
  // lease on the two opens, which is a different path entirely.
  expect(mockStart).toHaveBeenCalledWith({ requiresApproval: false })
})

it("stops the pump when the brain shuts down", async () => {
  const result = await bootstrapHeadlessRuntimes(context())
  await result.stop()
  expect(stop).toHaveBeenCalledTimes(1)
})
