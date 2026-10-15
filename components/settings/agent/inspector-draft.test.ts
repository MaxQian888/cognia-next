import {
  buildDraftUpdate,
  countDirtyFields,
  draftFromAgent,
  rebaseDraft,
  type ConnectionDraft,
} from "./inspector-draft"
import { tokenizeShellCommand } from "@/lib/mcp/config-transfer"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

const agent: LifecycleExternalAgentConfig = {
  id: "one",
  name: "Agent",
  protocol: "acp",
  transport: "stdio",
  enabled: true,
}

it("projects missing fields to editable defaults without mutating the agent", () => {
  expect(draftFromAgent(agent)).toEqual({
    name: "Agent",
    description: "",
    stateIsolation: "shared",
    sessionLimit: "",
    sessionIdleTimeout: "",
    processCommand: "",
    processArgs: "",
    processCwd: "",
    networkEndpoint: "",
    networkApiKey: "",
    timeoutMs: "300000",
    retryMaxRetries: "3",
    retryDelayMs: "1000",
    retryMaxDelayMs: "30000",
    retryExponentialBackoff: true,
  })
  expect(agent.process).toBeUndefined()
})

it("preserves configured zeroes, false, credentials and argument boundaries", () => {
  const args = ["--skill", "my skills", "", "quote'and\"double"]
  const draft = draftFromAgent({
    ...agent,
    description: "Work",
    stateIsolation: "isolated",
    maxConcurrentSessions: 2,
    process: { command: "pi", args, cwd: "/work" },
    network: { endpoint: "https://agent", apiKey: "secret" },
    timeout: 0,
    retryConfig: { maxRetries: 0, retryDelay: 0, maxRetryDelay: 0, exponentialBackoff: false },
  })
  expect(tokenizeShellCommand(draft.processArgs)).toEqual(args)
  expect(draft).toMatchObject({
    description: "Work",
    stateIsolation: "isolated",
    sessionLimit: "2",
    processCommand: "pi",
    processCwd: "/work",
    networkEndpoint: "https://agent",
    networkApiKey: "secret",
    timeoutMs: "0",
    retryMaxRetries: "0",
    retryDelayMs: "0",
    retryMaxDelayMs: "0",
    retryExponentialBackoff: false,
  })
})

const base = draftFromAgent(agent)
const changed: ConnectionDraft = {
  name: "New",
  description: "Description",
  stateIsolation: "isolated",
  sessionLimit: "3",
  sessionIdleTimeout: "500",
  processCommand: "codex",
  processArgs: "app-server",
  processCwd: "/new",
  networkEndpoint: "http://localhost",
  networkApiKey: "key",
  timeoutMs: "200",
  retryMaxRetries: "1",
  retryDelayMs: "20",
  retryMaxDelayMs: "50",
  retryExponentialBackoff: false,
}

it.each(Object.keys(base) as (keyof ConnectionDraft)[])(
  "rebases untouched %s and keeps a user edit",
  (key) => {
    const edited = { ...base, [key]: changed[key] }
    expect(countDirtyFields(edited, base)).toBe(1)
    expect(rebaseDraft(base, base, changed)).toEqual(changed)
    expect(rebaseDraft(edited, base, base)).toEqual(edited)
    expect(rebaseDraft(edited, base, changed)).toEqual(changed)
  }
)

it("merges disjoint changes and keeps the draft on a conflict without mutating inputs", () => {
  const draft = Object.freeze({ ...base, name: "My name", processCommand: "my-cli" })
  const remote = Object.freeze({ ...base, name: "Their name", description: "Synced" })
  const result = rebaseDraft(draft, Object.freeze(base), remote)
  expect(result).toEqual({ ...remote, name: "My name", processCommand: "my-cli" })
  expect(countDirtyFields(result, remote)).toBe(2)
  expect(countDirtyFields(base, base)).toBe(0)
  expect(countDirtyFields(changed, base)).toBe(Object.keys(base).length)
})

it("treats a reverted field as untouched and a saved edit as clean", () => {
  const draft = { ...base, description: "Saved" }
  const saved = { ...base, description: "Saved", processCommand: "server" }
  expect(countDirtyFields(rebaseDraft(draft, base, saved), saved)).toBe(0)
  expect(rebaseDraft(base, base, saved)).toEqual(saved)
})

describe("buildDraftUpdate", () => {
  const configured = {
    ...agent,
    process: { command: "pi", args: ["my skills", ""], cwd: "/work", env: { KEEP: "yes" } },
    maxConcurrentSessions: 2,
    sessionIdleTimeout: 60000,
    retryConfig: {
      maxRetries: 3,
      retryDelay: 1000,
      maxRetryDelay: 30000,
      exponentialBackoff: true,
      retryOnErrors: ["busy"],
    },
  }
  const baseline = draftFromAgent(configured)

  it("writes changed fields only and preserves process environment and argument boundaries", () => {
    expect(buildDraftUpdate(configured, { ...baseline, processCwd: "/next" }, baseline)).toEqual({
      errors: {},
      updates: { process: { ...configured.process, cwd: "/next" } },
    })
    expect(buildDraftUpdate(configured, { ...baseline, name: "  Review  " }, baseline)).toEqual({
      errors: {},
      updates: { name: "Review" },
    })
  })

  it.each([
    ["name", " ", "nameRequired"],
    ["processCommand", " ", "commandRequired"],
    ["processArgs", "'unclosed", "argumentsInvalid"],
    ["sessionLimit", "0", "sessionLimitInvalid"],
    ["sessionLimit", "1.5", "sessionLimitInvalid"],
    ["sessionIdleTimeout", "-1", "invalidIdleTimeout"],
    ["sessionIdleTimeout", "2.5", "invalidIdleTimeout"],
    ["timeoutMs", "-1", "mobileDetailNonNegativeIntegerInvalid"],
    ["timeoutMs", "2.3", "mobileDetailNonNegativeIntegerInvalid"],
    ["retryMaxRetries", "2junk", "mobileDetailNonNegativeIntegerInvalid"],
    ["retryDelayMs", "", "mobileDetailNonNegativeIntegerInvalid"],
    ["retryMaxDelayMs", "Infinity", "mobileDetailNonNegativeIntegerInvalid"],
  ] as const)("reports %s inline validation for %s", (field, value, error) => {
    expect(buildDraftUpdate(configured, { ...baseline, [field]: value }, baseline).errors).toEqual({
      [field]: error,
    })
  })

  it("clears both optional session values with null", () => {
    expect(
      buildDraftUpdate(
        configured,
        { ...baseline, sessionLimit: "", sessionIdleTimeout: "" },
        baseline
      )
    ).toEqual({
      errors: {},
      updates: { maxConcurrentSessions: null, sessionIdleTimeout: null },
    })
  })

  it("accepts numeric zeroes and retains unedited retry policy", () => {
    expect(
      buildDraftUpdate(configured, { ...baseline, timeoutMs: "0", retryMaxRetries: "0" }, baseline)
    ).toEqual({
      errors: {},
      updates: { timeout: 0, retryConfig: { ...configured.retryConfig, maxRetries: 0 } },
    })
  })

  it("validates an unchanged selected required field without blocking on other invalid drafts", () => {
    const empty = draftFromAgent(agent)
    expect(buildDraftUpdate(agent, empty, empty, ["processCommand"]).errors).toEqual({
      processCommand: "commandRequired",
    })
    expect(
      buildDraftUpdate(
        configured,
        { ...baseline, name: "New", timeoutMs: "bad", sessionLimit: "bad" },
        baseline,
        ["name"]
      )
    ).toEqual({ errors: {}, updates: { name: "New" } })
  })

  it("keeps live siblings when a drawer opened against an earlier revision", () => {
    const live = {
      ...configured,
      process: { ...configured.process, args: ["new arg"], cwd: "/live" },
    }
    const liveBase = draftFromAgent(live)
    expect(
      buildDraftUpdate(live, { ...baseline, processCommand: "codex" }, liveBase, ["processCommand"])
    ).toEqual({
      errors: {},
      updates: { process: { ...live.process, command: "codex" } },
    })
  })

  it("requires network endpoints and preserves saved credentials and network options", () => {
    const networkAgent = {
      ...configured,
      transport: "http" as const,
      network: { endpoint: "https://agent", headers: { "X-Keep": "yes" } },
      credentialRefs: { apiKey: "keyring" },
    }
    const networkBase = draftFromAgent(networkAgent)
    expect(
      buildDraftUpdate(networkAgent, { ...networkBase, networkEndpoint: " " }, networkBase).errors
    ).toEqual({ networkEndpoint: "endpointRequired" })
    expect(
      buildDraftUpdate(
        networkAgent,
        { ...networkBase, networkEndpoint: "https://next" },
        networkBase
      )
    ).toEqual({
      errors: {},
      updates: {
        network: { ...networkAgent.network, endpoint: "https://next", apiKey: undefined },
      },
    })
  })

  it("uses the existing isolation capability rule for an unsupported command", () => {
    const unknown = { ...configured, process: { command: "unknown-custom-cli", args: [] } }
    const unknownBase = draftFromAgent(unknown)
    expect(
      buildDraftUpdate(unknown, { ...unknownBase, stateIsolation: "isolated" }, unknownBase).updates
    ).toEqual({ stateIsolation: "shared" })
  })
})
