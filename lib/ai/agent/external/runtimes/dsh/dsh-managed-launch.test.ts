import { prepareDshManagedLaunch } from "./dsh-managed-launch"
import { buildDshChannelManifest } from "./dsh-runtime-install"
import { agentInvoke } from "../../agent-transport"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

jest.mock("../../agent-transport", () => ({ agentInvoke: jest.fn() }))
const readSecrets = jest.fn()
jest.mock("../../lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({ readSecrets }),
}))
const digest = "a".repeat(64)
const channel = buildDshChannelManifest({ lockfileDigest: digest, compositionDigest: digest })
const facts = {
  manifestJson: JSON.stringify(channel),
  lockfileDigest: digest,
  compositionDigest: digest,
  nodeVersion: "v26.3.1",
  platform: "darwin-arm64",
  strayPatchPaths: [],
  hasNativeToolchain: true,
  runtimeHome: "/cognia/deepseek-harness",
  nodePath: "/node/bin/node",
  defaultWorkspace: "/work",
  parentEnv: { PATH: "/bin", OTHER_API_KEY: "must-not-pass" },
}
function config(profileId = "cognia-sdk-readonly"): ExternalAgentConfig {
  return {
    id: "dsh",
    name: "DSH",
    protocol: profileId === "cognia-acp" ? "acp" : "dsh-sdk",
    transport: "stdio",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    process: { command: "", args: [], cwd: "/project" },
    metadata: { dshProfileId: profileId },
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(agentInvoke).mockResolvedValue(facts)
  readSecrets.mockResolvedValue({ processEnv: { DEEPSEEK_API_KEY: "test-deepseek-secret" } })
})
it.each(["cognia-sdk-readonly", "cognia-sdk-workspace", "cognia-acp"])(
  "resolves installed %s without mutating saved config",
  async (profile) => {
    const saved = config(profile)
    const launched = await prepareDshManagedLaunch(saved)
    expect(launched.process).toMatchObject({
      command: facts.nodePath,
      cwd: "/project",
      args: [
        "/cognia/deepseek-harness/launcher.mjs",
        expect.stringMatching(/host\.(sdk-readonly|sdk-workspace|acp)\.yml$/),
      ],
      env: {
        DEEPSEEK_API_KEY: "test-deepseek-secret",
        COGNIA_DSH_WORKSPACE: "/project",
        PATH: "/bin",
      },
    })
    expect(launched.process?.env?.OTHER_API_KEY).toBeUndefined()
    expect(saved.process).toEqual({ command: "", args: [], cwd: "/project" })
  }
)
it("does not touch other runtimes", async () => {
  const saved = { ...config(), metadata: {} }
  expect(await prepareDshManagedLaunch(saved)).toBe(saved)
  expect(agentInvoke).not.toHaveBeenCalled()
})
it("fails preflight before reading credentials or launching", async () => {
  jest.mocked(agentInvoke).mockResolvedValue({ ...facts, compositionDigest: "bad" })
  await expect(prepareDshManagedLaunch(config())).rejects.toThrow("needs repair")
  expect(readSecrets).not.toHaveBeenCalled()
})
it("rejects profile/protocol mismatch and missing credentials", async () => {
  await expect(prepareDshManagedLaunch({ ...config(), protocol: "acp" })).rejects.toThrow(
    "does not match"
  )
  readSecrets.mockResolvedValue({})
  await expect(prepareDshManagedLaunch(config())).rejects.toThrow("DeepSeek API key")
})
it("uses host workspace when unset and supplied transient secrets without reading keyring", async () => {
  const saved = config()
  saved.process = { command: "", env: { DEEPSEEK_API_KEY: "supplied-transient-secret" } }
  expect((await prepareDshManagedLaunch(saved)).process?.cwd).toBe("/work")
  expect(readSecrets).not.toHaveBeenCalled()
})
it("rejects unknown profiles and old hosts without launch facts", async () => {
  await expect(prepareDshManagedLaunch(config("unknown"))).rejects.toThrow("Unknown")
  jest.mocked(agentInvoke).mockResolvedValue({ ...facts, nodePath: undefined })
  await expect(prepareDshManagedLaunch(config())).rejects.toThrow("update the host")
})
it("rejects malformed channel manifests", async () => {
  jest.mocked(agentInvoke).mockResolvedValue({ ...facts, manifestJson: "{" })
  await expect(prepareDshManagedLaunch(config())).rejects.toThrow("channel-malformed")
})

it("preserves explicit model tuning and endpoint through managed preparation", async () => {
  const saved = config()
  const env = {
    COGNIA_DSH_MODEL: "deepseek-v4-pro",
    COGNIA_DSH_MAX_TOKENS: "1024",
    COGNIA_DSH_REASONING_EFFORT: "high",
    COGNIA_DSH_CONTEXT_WINDOW: "128000",
    COGNIA_DSH_PERSONA: "Be brief",
    DEEPSEEK_BASE_URL: "http://127.0.0.1:9876",
  }
  saved.process = { command: "", env }
  expect((await prepareDshManagedLaunch(saved)).process?.env).toMatchObject(env)
})
it.each(["", "0", "-1", "NaN", "1.5", "9007199254740992"])(
  "rejects invalid token tuning %s",
  async (value) => {
    const saved = config()
    saved.process = { command: "", env: { COGNIA_DSH_MAX_TOKENS: value } }
    await expect(prepareDshManagedLaunch(saved)).rejects.toThrow("positive safe integer")
  }
)

it("blocks unsafe persona content before handing a launch spec to the host", async () => {
  const saved = config()
  saved.process = { command: "", env: { COGNIA_DSH_PERSONA: "Contact alice@example.com" } }
  await expect(prepareDshManagedLaunch(saved)).rejects.toThrow("persona blocked by PII gate")
})

it.each(["cognia-sdk-readonly", "cognia-acp"])(
  "preserves task-scoped Cognia model routing for %s without own-provider credentials",
  async (profile) => {
    const saved = config(profile)
    saved.metadata!.cogniaGatewayTask = "task-1"
    const env = {
      COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify({ runtime: "dsh", taskId: "task-1" }),
      COGNIA_GATEWAY_TOKEN: "task-lease",
      COGNIA_DSH_GATEWAY_CONFIG: JSON.stringify({ provider: "cognia", model: "model-1" }),
      COGNIA_DSH_GATEWAY_TOKEN: "task-lease",
      COGNIA_DSH_PROVIDER: "cognia",
      COGNIA_DSH_MODEL: "model-1",
    }
    saved.process = { command: "", env: { ...env, DEEPSEEK_API_KEY: "unused-own-key" } }
    const launched = await prepareDshManagedLaunch(saved)
    expect(launched.process?.env).toMatchObject(env)
    expect(launched.process?.env?.DEEPSEEK_API_KEY).toBeUndefined()
    expect(readSecrets).not.toHaveBeenCalled()
    expect(saved.process.command).toBe("")
  }
)
it.each([
  "{",
  "null",
  '{"runtime":"codex","taskId":"task-1"}',
  '{"runtime":"dsh","taskId":"another-task"}',
])("rejects incomplete or mismatched Cognia task lease %s", async (taskConfig) => {
  const saved = config()
  saved.metadata!.cogniaGatewayTask = "task-1"
  saved.process = { command: "", env: { COGNIA_GATEWAY_TASK_CONFIG: taskConfig } }
  await expect(prepareDshManagedLaunch(saved)).rejects.toThrow("task-scoped lease")
  expect(readSecrets).not.toHaveBeenCalled()
})
