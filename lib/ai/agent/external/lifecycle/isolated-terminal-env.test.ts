import { resolveIsolatedTerminalEnv } from "./isolated-terminal-env"
import { getExternalAgentStateRootInfo } from "./state-root"
import { agentStateIsolationFor } from "../policy/security-policy"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

jest.mock("./state-root", () => ({ getExternalAgentStateRootInfo: jest.fn() }))
jest.mock("../policy/security-policy", () => ({
  ...jest.requireActual("../policy/security-policy"),
  agentStateIsolationFor: jest.fn(
    jest.requireActual("../policy/security-policy").agentStateIsolationFor
  ),
}))
const rootInfo = jest.mocked(getExternalAgentStateRootInfo)
const isolationRule = jest.mocked(agentStateIsolationFor)
const config: ExternalAgentConfig = {
  id: "pi-one",
  name: "Pi",
  enabled: true,
  protocol: "pi-rpc",
  transport: "stdio",
  stateIsolation: "isolated",
  process: { command: "pi" },
}
beforeEach(() => {
  rootInfo.mockReset().mockResolvedValue({ path: "/state/pi-one", exists: false, bytes: 0 })
  isolationRule
    .mockReset()
    .mockImplementation(jest.requireActual("../policy/security-policy").agentStateIsolationFor)
})

it.each<Partial<ExternalAgentConfig>>([
  { stateIsolation: "shared" },
  { stateIsolation: undefined },
  { transport: "http" },
  { transport: "websocket" },
  { process: undefined },
  { process: { command: "" } },
  { process: { command: "unknown-runtime" } },
  { metadata: { cogniaGatewayTask: true } },
  {
    process: { command: "pi", env: { COGNIA_BOT_ISOLATION: "1", COGNIA_AGENT_STATE_KEY: "stale" } },
  },
])("returns shared without reading a root for %j", async (patch) => {
  await expect(resolveIsolatedTerminalEnv({ ...config, ...patch })).resolves.toEqual({
    kind: "shared",
  })
  expect(rootInfo).not.toHaveBeenCalled()
})

it.each([
  ["/state/pi-one", "/state/pi-one/pi"],
  ["/state/pi-one/", "/state/pi-one/pi"],
  ["C:\\state\\pi-one", "C:\\state\\pi-one\\pi"],
  ["C:\\state\\pi-one\\", "C:\\state\\pi-one\\pi"],
  ["/", "/pi"],
])("joins the private home under %s", async (path, expected) => {
  rootInfo.mockResolvedValue({ path, exists: false, bytes: 0 })
  await expect(resolveIsolatedTerminalEnv(config)).resolves.toEqual({
    kind: "isolated",
    env: { PI_CODING_AGENT_DIR: expected },
  })
  expect(rootInfo).toHaveBeenCalledWith(config.id)
})

it("maps every environment key from the policy, overriding no caller data", async () => {
  isolationRule.mockReturnValue({
    env: { HOME_A: "a", HOME_B: "b" },
    sharedRoots: [],
    denyReadable: [],
  })
  const original = { ...config, process: { command: "pi", env: { HOME_A: "/stale" } } }
  await expect(resolveIsolatedTerminalEnv(original)).resolves.toEqual({
    kind: "isolated",
    env: { HOME_A: "/state/pi-one/a", HOME_B: "/state/pi-one/b" },
  })
  expect(original.process.env.HOME_A).toBe("/stale")
})

it("resolves a package launch using the command and args", async () => {
  await expect(
    resolveIsolatedTerminalEnv({
      ...config,
      process: { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
    })
  ).resolves.toMatchObject({ kind: "isolated" })
})

it("reports a missing local root", async () => {
  rootInfo.mockResolvedValue(null)
  await expect(resolveIsolatedTerminalEnv(config)).resolves.toEqual({
    kind: "unavailable",
    reason: "no-state-root",
  })
})

it("reports isolation blocked by an invalid configuration id before reading a root", async () => {
  await expect(resolveIsolatedTerminalEnv({ ...config, id: "../bad" })).resolves.toEqual({
    kind: "unavailable",
    reason: "isolation-unsupported",
  })
  expect(rootInfo).not.toHaveBeenCalled()
})

it("propagates state-root failures so callers cannot launch into shared state", async () => {
  rootInfo.mockRejectedValue(new Error("host unavailable"))
  await expect(resolveIsolatedTerminalEnv(config)).rejects.toThrow("host unavailable")
})
