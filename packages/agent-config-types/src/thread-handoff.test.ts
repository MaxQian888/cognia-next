import {
  canTransition,
  isTerminalHandoffState,
  isThreadHandoffTicket,
  THREAD_HANDOFF_STATES,
  THREAD_HANDOFF_TICKET_VERSION,
  THREAD_HANDOFF_TRANSITIONS,
  validateThreadHandoffRefs,
  validateThreadHandoffTicket,
  type ThreadHandoffState,
  type ThreadHandoffTicket,
} from "./thread-handoff"

function makeTicket(overrides: Partial<ThreadHandoffTicket> = {}): ThreadHandoffTicket {
  return {
    ticketVersion: THREAD_HANDOFF_TICKET_VERSION,
    ticketId: "tkt-1",
    state: "preparing",
    role: "source",
    source: {
      hostRef: "local",
      kind: "desktop",
      sessionId: "sess-1",
      title: "Thread",
      messageCount: 3,
    },
    target: { hostRef: "host-b", kind: "cli" },
    transport: "cli-bridge",
    project: {},
    requirements: {
      capabilities: ["shell"],
      hostOperations: [{ feature: "claude.host-tools" }],
      providerRefs: [],
      models: [],
      credentialProfileRefs: [],
    },
    continuation: {
      sourceRuntime: "claude-code",
      fidelity: "structured",
      sequenceDigest: "seq1-0000abcd",
    },
    attachments: [],
    pendingApprovals: [],
    history: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 100_000,
    ...overrides,
  }
}

describe("state machine", () => {
  it("declares a transition list for every state", () => {
    expect(Object.keys(THREAD_HANDOFF_TRANSITIONS).sort()).toEqual(
      [...THREAD_HANDOFF_STATES].sort()
    )
  })

  it.each([
    ["preparing", "frozen"],
    ["preparing", "aborted"],
    ["frozen", "accepted"],
    ["frozen", "aborted"],
    ["accepted", "committed"],
    ["accepted", "aborted"],
  ] as const)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true)
  })

  it.each([
    // Skipping the freeze would transmit a thread that is still writable.
    ["preparing", "accepted"],
    ["preparing", "committed"],
    // Committing without the target accepting would create a second writable copy.
    ["frozen", "committed"],
    // Terminal states are terminal.
    ["committed", "aborted"],
    ["committed", "frozen"],
    ["aborted", "frozen"],
    ["aborted", "committed"],
    // No state may loop back to preparing — the ticket would lose its history.
    ["frozen", "preparing"],
    ["accepted", "preparing"],
  ] as const)("forbids %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false)
  })

  it("forbids every self-transition", () => {
    for (const state of THREAD_HANDOFF_STATES) {
      expect(canTransition(state, state)).toBe(false)
    }
  })

  it("returns false for an unknown state rather than throwing", () => {
    expect(canTransition("nope" as ThreadHandoffState, "frozen")).toBe(false)
  })

  it.each([
    ["committed", true],
    ["aborted", true],
    ["preparing", false],
    ["frozen", false],
    ["accepted", false],
  ] as const)("isTerminalHandoffState(%s) → %p", (state, expected) => {
    expect(isTerminalHandoffState(state)).toBe(expected)
  })

  it("freezes the transition table against mutation", () => {
    expect(Object.isFrozen(THREAD_HANDOFF_TRANSITIONS)).toBe(true)
    expect(Object.isFrozen(THREAD_HANDOFF_TRANSITIONS.frozen)).toBe(true)
  })
})

describe("validateThreadHandoffTicket", () => {
  it("accepts a well-formed ticket", () => {
    expect(validateThreadHandoffTicket(makeTicket())).toEqual([])
    expect(isThreadHandoffTicket(makeTicket())).toBe(true)
  })

  it.each([null, undefined, "x", []])("rejects non-object %p", (value) => {
    expect(validateThreadHandoffTicket(value)).toEqual(["ticket must be an object"])
  })

  it.each([
    ["ticketVersion", { ticketVersion: 2 as never }, "ticketVersion must be 1"],
    ["ticketId", { ticketId: "" }, "ticketId is required"],
    ["state", { state: "nope" as never }, "state must be a known ThreadHandoffState"],
    ["role", { role: "peer" as never }, 'role must be "source" or "target"'],
    [
      "transport",
      { transport: "carrier-pigeon" as never },
      "transport must be a known ThreadHandoffTransport",
    ],
    ["project", { project: undefined as never }, "project is required"],
    ["history", { history: {} as never }, "history must be an array"],
    ["createdAt", { createdAt: Number.NaN }, "createdAt must be a finite number"],
    ["updatedAt", { updatedAt: "soon" as never }, "updatedAt must be a finite number"],
    ["expiresAt", { expiresAt: Number.POSITIVE_INFINITY }, "expiresAt must be a finite number"],
  ])("rejects a bad %s", (_label, overrides, expected) => {
    expect(validateThreadHandoffTicket(makeTicket(overrides))).toContain(expected)
  })

  describe("host refs", () => {
    it("requires source and target", () => {
      const errors = validateThreadHandoffTicket(
        makeTicket({ source: undefined as never, target: undefined as never })
      )
      expect(errors).toContain("source is required")
      expect(errors).toContain("target is required")
    })

    it("requires a hostRef, a known kind, and a source sessionId", () => {
      const ticket = makeTicket({
        source: {
          hostRef: "",
          kind: "quantum" as never,
          sessionId: "",
          title: "",
          messageCount: 0,
        },
      })
      const errors = validateThreadHandoffTicket(ticket)
      expect(errors).toContain("source.hostRef is required")
      expect(errors).toContain("source.kind must be a known ThreadHandoffHostKind")
      expect(errors).toContain("source.sessionId is required")
    })

    it("rejects a URL-shaped hostRef", () => {
      const ticket = makeTicket({ target: { hostRef: "https://host", kind: "cloud" } })
      expect(validateThreadHandoffTicket(ticket)).toContain(
        "target.hostRef: URL-shaped value in a ref position"
      )
    })
  })

  describe("requirements", () => {
    it("requires the four string arrays", () => {
      const ticket = makeTicket({
        requirements: {
          capabilities: "shell" as never,
          hostOperations: [],
          providerRefs: [1] as never,
          models: undefined as never,
          credentialProfileRefs: {} as never,
        },
      })
      const errors = validateThreadHandoffTicket(ticket)
      expect(errors).toContain("requirements.capabilities must be a string array")
      expect(errors).toContain("requirements.providerRefs must be a string array")
      expect(errors).toContain("requirements.models must be a string array")
      expect(errors).toContain("requirements.credentialProfileRefs must be a string array")
    })

    it("requires requirements itself", () => {
      expect(validateThreadHandoffTicket(makeTicket({ requirements: null as never }))).toContain(
        "requirements is required"
      )
    })

    it("requires each hostOperation to name a feature", () => {
      const ticket = makeTicket({
        requirements: { ...makeTicket().requirements, hostOperations: [{ feature: "" }] },
      })
      expect(validateThreadHandoffTicket(ticket)).toContain(
        "requirements.hostOperations[0].feature is required"
      )
    })

    it("rejects a non-array hostOperations and a bad minProtocolVersion", () => {
      const ticket = makeTicket({
        requirements: {
          ...makeTicket().requirements,
          hostOperations: "none" as never,
          minProtocolVersion: Number.NaN,
        },
      })
      const errors = validateThreadHandoffTicket(ticket)
      expect(errors).toContain("requirements.hostOperations must be an array")
      expect(errors).toContain("requirements.minProtocolVersion must be a finite number")
    })
  })

  describe("continuation", () => {
    it("requires continuation itself", () => {
      expect(
        validateThreadHandoffTicket(makeTicket({ continuation: undefined as never }))
      ).toContain("continuation is required")
    })

    it("requires runtime, fidelity, and digest", () => {
      const ticket = makeTicket({
        continuation: { sourceRuntime: "", fidelity: "" as never, sequenceDigest: "" },
      })
      const errors = validateThreadHandoffTicket(ticket)
      expect(errors).toContain("continuation.sourceRuntime is required")
      expect(errors).toContain("continuation.fidelity is required")
      expect(errors).toContain("continuation.sequenceDigest is required")
    })
  })

  describe("attachments", () => {
    it("rejects a non-array and a non-object entry", () => {
      expect(validateThreadHandoffTicket(makeTicket({ attachments: {} as never }))).toContain(
        "attachments must be an array"
      )
      expect(validateThreadHandoffTicket(makeTicket({ attachments: ["x" as never] }))).toContain(
        "attachments[0] must be an object"
      )
    })

    it("requires id, digest, a non-negative size, and a known carriage", () => {
      const ticket = makeTicket({
        attachments: [
          {
            attachmentId: "",
            filename: "a.png",
            mediaType: "image/png",
            byteLength: -1,
            digest: "",
            carriage: "telepathy" as never,
          },
        ],
      })
      const errors = validateThreadHandoffTicket(ticket)
      expect(errors).toContain("attachments[0].attachmentId is required")
      expect(errors).toContain("attachments[0].digest is required")
      expect(errors).toContain("attachments[0].byteLength must be a non-negative number")
      expect(errors).toContain("attachments[0].carriage must be a known ThreadHandoffCarriage")
    })

    it("requires a ref when carriage is by-ref", () => {
      const ticket = makeTicket({
        attachments: [
          {
            attachmentId: "a1",
            filename: "a.png",
            mediaType: "image/png",
            byteLength: 10,
            digest: "abc",
            carriage: "by-ref",
          },
        ],
      })
      expect(validateThreadHandoffTicket(ticket)).toContain(
        'attachments[0].ref is required when carriage is "by-ref"'
      )
    })
  })

  describe("pendingApprovals", () => {
    it("accepts pending and denied", () => {
      const ticket = makeTicket({
        pendingApprovals: [
          { requestId: "r1", toolName: "Bash", state: "pending", requestedAt: 1 },
          { requestId: "r2", toolName: "Write", state: "denied", requestedAt: 2 },
        ],
      })
      expect(validateThreadHandoffTicket(ticket)).toEqual([])
    })

    // The ADR-0090 restore rule, enforced structurally.
    it.each(["allow", "allow_always", "granted"])(
      "refuses to carry a granted approval (%p)",
      (state) => {
        const ticket = makeTicket({
          pendingApprovals: [
            { requestId: "r1", toolName: "Bash", state: state as never, requestedAt: 1 },
          ],
        })
        expect(validateThreadHandoffTicket(ticket)).toContain(
          'pendingApprovals[0].state must be "pending" or "denied" — a granted approval is never transferred'
        )
      }
    )

    it("rejects a non-array and a non-object entry", () => {
      expect(validateThreadHandoffTicket(makeTicket({ pendingApprovals: 1 as never }))).toContain(
        "pendingApprovals must be an array"
      )
      expect(
        validateThreadHandoffTicket(makeTicket({ pendingApprovals: ["x" as never] }))
      ).toContain("pendingApprovals[0] must be an object")
    })

    it("requires a requestId", () => {
      const ticket = makeTicket({
        pendingApprovals: [{ requestId: "", toolName: "Bash", state: "pending", requestedAt: 1 }],
      })
      expect(validateThreadHandoffTicket(ticket)).toContain(
        "pendingApprovals[0].requestId is required"
      )
    })
  })
})

describe("validateThreadHandoffRefs", () => {
  it("passes a clean ticket", () => {
    expect(validateThreadHandoffRefs(makeTicket())).toEqual([])
  })

  it("rejects a machine-local absolute workspaceRef", () => {
    const ticket = makeTicket({ project: { workspaceRef: "/Users/me/proj" } })
    expect(validateThreadHandoffRefs(ticket)).toContain(
      "project.workspaceRef: machine-local absolute path is not a stable ref"
    )
  })

  it("rejects a Windows absolute workspaceRef", () => {
    const ticket = makeTicket({ project: { workspaceRef: "C:\\proj" } })
    expect(validateThreadHandoffRefs(ticket)).toContain(
      "project.workspaceRef: machine-local absolute path is not a stable ref"
    )
  })

  it("accepts a logical workspaceRef", () => {
    expect(validateThreadHandoffRefs(makeTicket({ project: { workspaceRef: "ws-main" } }))).toEqual(
      []
    )
  })

  it("rejects key material in a credential profile ref", () => {
    const ticket = makeTicket({
      requirements: { ...makeTicket().requirements, credentialProfileRefs: ["sk-abc123"] },
    })
    expect(validateThreadHandoffRefs(ticket)).toContain(
      "requirements.credentialProfileRefs[0]: secret-shaped value in a ref position"
    )
  })

  it("rejects an absolute attachment ref", () => {
    const ticket = makeTicket({
      attachments: [
        {
          attachmentId: "a1",
          filename: "a.png",
          mediaType: "image/png",
          byteLength: 10,
          digest: "abc",
          carriage: "by-ref",
          ref: "/var/tmp/a.png",
        },
      ],
    })
    expect(validateThreadHandoffRefs(ticket)).toContain(
      "attachments[0].ref: machine-local absolute path is not a stable ref"
    )
  })

  it("rejects a URL-shaped host ref on either side", () => {
    const ticket = makeTicket({
      source: { ...makeTicket().source, hostRef: "https://a" },
      target: { hostRef: "https://b", kind: "cloud" },
    })
    const errors = validateThreadHandoffRefs(ticket)
    expect(errors).toContain("source.hostRef: URL-shaped value in a ref position")
    expect(errors).toContain("target.hostRef: URL-shaped value in a ref position")
  })

  it("ignores absent optional refs", () => {
    const ticket = makeTicket({ project: { sourceProjectId: "p1" } })
    expect(validateThreadHandoffRefs(ticket)).toEqual([])
  })
})
