import {
  classifyFileTreeFailure,
  isFileTreeFailureRetryable,
  type FileTreeFailure,
} from "./file-tree-failure"

function kindOf(error: unknown): FileTreeFailure["kind"] {
  return classifyFileTreeFailure(error).kind
}

describe("classifyFileTreeFailure", () => {
  it("never throws, whatever it is handed", () => {
    for (const value of [null, undefined, 0, {}, [], Symbol("x")]) {
      expect(() => classifyFileTreeFailure(value)).not.toThrow()
    }
  })

  /**
   * The default is `unreachable` because it is the only kind that invites a
   * retry. Asserting a cause the error never stated would send the reader to
   * fix the wrong thing.
   */
  it("falls back to unreachable rather than inventing a cause", () => {
    expect(kindOf(new Error("something nobody planned for"))).toBe("unreachable")
    expect(classifyFileTreeFailure(null)).toEqual({
      kind: "unreachable",
      detail: null,
      code: null,
    })
  })

  it("keeps the far side's own words as detail, and invents none", () => {
    expect(classifyFileTreeFailure(new Error("  EACCES: permission denied  ")).detail).toBe(
      "EACCES: permission denied"
    )
    expect(classifyFileTreeFailure(new Error("   ")).detail).toBeNull()
  })

  describe("POSIX and SFTP server errors", () => {
    it.each([
      ["EACCES: permission denied, open '/etc/shadow'", "denied"],
      ["EPERM: operation not permitted", "denied"],
      ["EROFS: read-only file system", "denied"],
      ["Access is denied.", "denied"],
      ["ENOENT: no such file or directory", "missing"],
      ["ENOTDIR: not a directory", "missing"],
      ["the path does not exist", "missing"],
      ["EEXIST: file already exists", "conflict"],
      ["ENOTEMPTY: directory not empty", "conflict"],
      ["ENOSPC: no space left on device", "capacity"],
      ["EDQUOT: quota exceeded", "capacity"],
    ] as const)("reads %s as %s", (message, expected) => {
      expect(kindOf(new Error(message))).toBe(expected)
    })
  })

  describe("companion refusals", () => {
    it("treats a non-retryable Host refusal as refused, keeping its code", () => {
      expect(
        classifyFileTreeFailure({ code: "command_transport_forbidden", retryable: false })
      ).toEqual({ kind: "refused", detail: null, code: "command_transport_forbidden" })
    })

    /**
     * A refusal can still be a permission problem, and the specific answer
     * sends the reader somewhere useful. "Not permitted" and "the Host will
     * not answer this at all" are different next steps.
     */
    it("prefers denied over refused when the code itself names permission", () => {
      expect(kindOf({ code: "permission_denied", retryable: false })).toBe("denied")
      expect(kindOf({ code: "unauthorized", retryable: false })).toBe("denied")
    })

    /**
     * `forbidden` is the transport layer's word for its own refusals.
     * `command_transport_forbidden` means "this command may not ride this
     * socket", and reading it as a file permission would send the reader to
     * check a mode on a call that never reached a filesystem.
     */
    it("does not read a transport refusal as a file permission", () => {
      expect(kindOf({ code: "command_transport_forbidden", retryable: false })).toBe("refused")
    })

    /**
     * `retryable` absent or true means the Host did not claim finality, so the
     * code is still worth reading but must not be promoted to a refusal.
     */
    it("does not treat a retryable error as a refusal", () => {
      expect(kindOf({ code: "host_offline", retryable: true })).toBe("unreachable")
    })

    it("classifies from a code even when nothing declared finality", () => {
      expect(kindOf({ code: "ENOENT" })).toBe("missing")
    })

    it("reads the code before the message, so a classifying Host wins", () => {
      const both = Object.assign(new Error("no such file or directory"), {
        code: "permission_denied",
        retryable: false,
      })
      expect(kindOf(both)).toBe("denied")
    })
  })

  it("accepts a bare string, which is what some transports throw", () => {
    expect(kindOf("ENOSPC: no space left on device")).toBe("capacity")
  })
})

describe("isFileTreeFailureRetryable", () => {
  /**
   * Only `unreachable`. Offering a retry on a permission denial trains people
   * to click it, which is how a real cause gets mistaken for a flaky link.
   */
  it("offers a retry for nothing the user must fix first", () => {
    expect(isFileTreeFailureRetryable({ kind: "unreachable", detail: null, code: null })).toBe(true)
    for (const kind of ["denied", "missing", "conflict", "capacity", "refused"] as const) {
      expect(isFileTreeFailureRetryable({ kind, detail: null, code: null })).toBe(false)
    }
  })
})
