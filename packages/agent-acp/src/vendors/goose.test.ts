import { gooseAcpProfile } from "./goose"

describe("gooseAcpProfile", () => {
  const modes = gooseAcpProfile.permissionModes!

  it("keeps edit-only and deny policies in the host broker", () => {
    expect(modes.toNative("acceptEdits")).toBe("approve")
    expect(modes.toNative("plan")).toBe("chat")
    expect(modes.toNative("bypassPermissions")).toBe("auto")
    expect(modes.toCanonical("approve", "dontAsk")).toBe("dontAsk")
    expect(modes.toCanonical("approve", "plan")).toBe("default")
  })

  it("starts with approval enabled and matches allow-lists by tool name", () => {
    expect(gooseAcpProfile.launchEnv).toEqual({ GOOSE_MODE: "approve" })
    expect(gooseAcpProfile.permissionModes?.mandatoryApprovalMode).toBe("approve")
    expect(gooseAcpProfile.preApprovalMatchesToolName).toBe(true)
  })

  it("recovers the tool identity and classifies platform file operations", () => {
    const identity = gooseAcpProfile.toolIdentity!
    expect(identity({ goose: { toolCall: { toolName: "cognia-tools__read" } } })).toEqual({
      name: "mcp__cognia-tools__read",
      kind: undefined,
    })
    expect(identity({ goose: { toolCall: { toolName: "edit" } } })).toEqual({
      name: "edit",
      kind: "edit",
    })
    expect(identity({ goose: { toolCall: { toolName: "read" } } })?.kind).toBe("read")
    expect(identity({ goose: { toolCall: { toolName: "  " } } })).toBeUndefined()
    expect(identity(undefined)).toBeUndefined()
  })

  it("preserves exact dotted and hashed tool identities from native metadata", () => {
    for (const name of [
      "extension__search.docs",
      `extension__${"a".repeat(45)}_d3adbeef`,
      "cognia-tools__search.docs",
    ]) {
      expect(gooseAcpProfile.toolIdentity!({ goose: { toolCall: { toolName: name } } })?.name).toBe(
        name.startsWith("cognia-tools__") ? `mcp__${name}` : name
      )
    }
  })

  it("accepts only bounded passive child metadata", () => {
    expect(
      gooseAcpProfile.toolMetadata!({ goose: { subagentSessionId: "child" } }, "parent")
    ).toEqual({
      nativeSubagent: {
        runtime: "goose",
        sessionId: "child",
        parentSessionId: "parent",
        readOnly: true,
      },
    })
    for (const id of ["", " ", "child\n", "x".repeat(257), 5]) {
      expect(
        gooseAcpProfile.toolMetadata!({ goose: { subagentSessionId: id } }, "parent")
      ).toBeUndefined()
    }
  })

  it("projects native status and cumulative usage without inventing tokens or progress", () => {
    const notification = gooseAcpProfile.notification!
    const method = "_goose/unstable/session/update"
    const timestamp = new Date()
    const notice = notification(
      method,
      {
        sessionId: "p",
        update: {
          sessionUpdate: "status_message",
          status: { type: "notice", message: "Compacting" },
        },
      },
      timestamp
    )
    expect(notice).toMatchObject({
      type: "extension_ui_update",
      sessionId: "p",
      update: { message: "Compacting" },
    })
    expect(
      notification(
        method,
        {
          sessionId: "p",
          update: {
            sessionUpdate: "status_message",
            status: { type: "progress", message: "Running" },
          },
        },
        timestamp
      )
    ).toEqual({ type: "commentary_delta", sessionId: "p", timestamp, text: "Running" })
    expect(
      notification(
        method,
        {
          sessionId: "p",
          update: {
            sessionUpdate: "usage_update",
            used: 10,
            contextLimit: 100,
            accumulatedCost: 0,
          },
        },
        timestamp
      )
    ).toEqual({
      type: "usage_update",
      sessionId: "p",
      timestamp,
      used: 10,
      size: 100,
      cost: { amount: 0, currency: "USD" },
    })
    expect(
      notification(
        method,
        { sessionId: "p", update: { sessionUpdate: "usage_update", used: NaN, contextLimit: 100 } },
        timestamp
      )
    ).toBeNull()
    expect(notification("session/update", { sessionId: "p" }, timestamp)).toBeNull()
    expect(notification(method, { sessionId: 1 }, timestamp)).toBeNull()
  })
})
