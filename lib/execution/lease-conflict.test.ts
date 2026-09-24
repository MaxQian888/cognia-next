import {
  LeaseConflictError,
  agentProcessConflictFrom,
  isLeaseConflictError,
  workingCopyConflict,
} from "./lease-conflict"

describe("lease conflicts", () => {
  it("types the task-workspace refusal and keeps the host's key as the holder", () => {
    const hostError = new Error("pipeline workspace is already active: managed-workspace:s_abc")
    const conflict = workingCopyConflict(hostError)
    expect(conflict).toBeInstanceOf(LeaseConflictError)
    expect(conflict.resource).toBe("working-copy")
    expect(conflict.holder).toBe("managed-workspace:s_abc")
    expect(conflict.cause).toBe(hostError)
    expect(isLeaseConflictError(conflict)).toBe(true)
  })

  it("types the process manager's id collision, including a bare string rejection", () => {
    const conflict = agentProcessConflictFrom("Agent pi:s_123 is already running")
    expect(conflict?.resource).toBe("agent-process")
    expect(conflict?.holder).toBe("pi:s_123")
  })

  it("leaves every other failure alone", () => {
    expect(agentProcessConflictFrom(new Error("No such file or directory (os error 2)"))).toBeNull()
    expect(isLeaseConflictError(new Error("boom"))).toBe(false)
  })

  it("passes an already-typed conflict through unchanged", () => {
    const typed = new LeaseConflictError("agent-process", "held", { holder: "pi:x" })
    expect(agentProcessConflictFrom(typed)).toBe(typed)
    expect(workingCopyConflict(typed)).toBe(typed)
    expect(agentProcessConflictFrom(new LeaseConflictError("working-copy", "held"))).toBeNull()
  })
})
