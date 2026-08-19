import { buildAgentEnrollmentSteps, defaultAgentId, shellQuote } from "./agent-enrollment"

describe("shellQuote", () => {
  it("closes, escapes, and reopens an embedded single quote", () => {
    // The only correct escape in `sh` — a backslash inside single quotes is
    // literal, so `\\'` would leave the string open and swallow the rest of
    // the command.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("plain")).toBe("'plain'")
  })

  it("neutralizes a token that tries to break out of its quoting", () => {
    const quoted = shellQuote("tok'; rm -rf /; echo '")
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    // Every original quote is escaped, so no bare `'` splits the argument.
    expect(quoted.slice(1, -1).replaceAll(`'\\''`, "")).not.toContain("'")
  })
})

describe("defaultAgentId", () => {
  it("slugs a target id into a shell- and DNS-safe agent name", () => {
    expect(defaultAgentId("staging")).toBe("staging-agent")
    expect(defaultAgentId("Tenant A/Prod")).toBe("tenant-a-prod-agent")
    expect(defaultAgentId("--edges--")).toBe("edges-agent")
  })

  it("falls back rather than producing a name that is only a suffix", () => {
    expect(defaultAgentId("///")).toBe("cognia-agent")
    expect(defaultAgentId("   ")).toBe("cognia-agent")
  })
})

describe("buildAgentEnrollmentSteps", () => {
  const input = {
    controllerUrl: "https://ops.example.com/",
    targetId: "staging",
    token: "6f1c0b6e-6c1a-4a7f-9c2f-2a0e2f7b1d33",
  }

  it("stages the token through a file instead of process arguments", () => {
    const steps = buildAgentEnrollmentSteps(input)
    const enroll = steps.find((step) => step.id === "enroll")

    expect(enroll?.command).toContain("--token-file /var/lib/cognia-agent/enrollment-token")
    // `--token` would put a single-use credential in `ps` output and shell
    // history, where it has effectively leaked before it is used.
    expect(enroll?.command).not.toContain("--token ")
  })

  it("removes the staged token once it has been spent", () => {
    const enroll = buildAgentEnrollmentSteps(input).find((step) => step.id === "enroll")
    expect(enroll?.command).toContain("sudo rm -f /var/lib/cognia-agent/enrollment-token")
  })

  it("trims a trailing slash off the controller URL", () => {
    const enroll = buildAgentEnrollmentSteps(input).find((step) => step.id === "enroll")
    // `enroll` joins this with `/v1/agents/enroll`; a doubled slash is a 404 on
    // some proxies and silently rewritten on others.
    expect(enroll?.command).toContain("--controller-url 'https://ops.example.com'")
  })

  it("quotes the token and the agent id", () => {
    const steps = buildAgentEnrollmentSteps({
      ...input,
      targetId: "tenant a",
      token: "tok'en",
    })
    expect(steps[0].command).toContain(`'tok'\\''en'`)
    expect(steps[1].command).toContain("--agent-id 'tenant-a-agent'")
  })

  it("honours an explicit agent id over the derived one", () => {
    const steps = buildAgentEnrollmentSteps({ ...input, agentId: "eu-west-1" })
    expect(steps[1].command).toContain("--agent-id 'eu-west-1'")
  })

  it("returns the three steps the runbook expects, in order", () => {
    expect(buildAgentEnrollmentSteps(input).map((step) => step.id)).toEqual([
      "stage-token",
      "enroll",
      "start",
    ])
  })
})
