import * as enrollment from "./index"

describe("lib/account-sync/enrollment public surface", () => {
  it("exports every flow", () => {
    for (const name of [
      "createAccountSyncContext",
      "readEnrollmentStatus",
      "prepareFirstDevice",
      "commitFirstDevice",
      "startJoin",
      "pollJoin",
      "completeJoin",
      "cancelJoin",
      "listIncoming",
      "beginApproval",
      "pollApproval",
      "confirmApproval",
      "denyRequest",
      "recoverWithKey",
      "revokeDevice",
      "rotateKeys",
      "prepareRecoveryKey",
      "commitRecoveryKey",
      "handleRevokedAnswer",
      "registryFingerprint",
      "pickConfirmationPositions",
      "confirmsRecoveryKey",
      "recoveryKitContents",
      "currentDevicePlatform",
      "withSpaceLock",
    ]) {
      expect(typeof (enrollment as Record<string, unknown>)[name]).toBe("function")
    }
  })
})
