import {
  isSftpTransferFinished,
  SFTP_MAX_QUEUED_BYTES,
  SFTP_TERMINAL_STATUSES,
  SftpTransferTooLargeError,
  type SftpTransferStatus,
} from "./transfer-types"

describe("isSftpTransferFinished", () => {
  /**
   * The pump asks this before it touches a row, and the controls ask it before
   * they offer cancel. A status wrongly counted as finished would leave a
   * transfer stuck with no way to move it, and one wrongly counted as live
   * would let the pump restart something a person cancelled.
   */
  it("answers for every status the queue can be in", () => {
    const answers: Record<SftpTransferStatus, boolean> = {
      queued: false,
      running: false,
      paused: false,
      done: true,
      failed: true,
      cancelled: true,
    }
    for (const [status, finished] of Object.entries(answers)) {
      expect(isSftpTransferFinished(status as SftpTransferStatus)).toBe(finished)
    }
    // Derived from the same table, so a status added without a decision here
    // fails rather than defaulting to "still running".
    expect([...SFTP_TERMINAL_STATUSES].sort()).toEqual(
      Object.entries(answers)
        .filter(([, finished]) => finished)
        .map(([status]) => status)
        .sort()
    )
  })
})

describe("SftpTransferTooLargeError", () => {
  /**
   * The limit exists because durability means writing the bytes down, so the
   * refusal names both the file's size and the ceiling. A bare "too large"
   * would leave the user guessing at which of the two to change.
   */
  it("names the size and the limit", () => {
    const error = new SftpTransferTooLargeError(SFTP_MAX_QUEUED_BYTES + 1)
    expect(error.size).toBe(SFTP_MAX_QUEUED_BYTES + 1)
    expect(error.message).toContain(String(SFTP_MAX_QUEUED_BYTES))
    expect(error.name).toBe("SftpTransferTooLargeError")
  })
})
