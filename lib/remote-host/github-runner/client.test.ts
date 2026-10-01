import {
  githubRunnerClient,
  linkRunnerHost,
  loadRunnerCreateConfig,
  normalizeRunnerRepository,
  runnerHostLinks,
  runnerRunUrl,
  saveRunnerCreateConfig,
  validateRunnerRequest,
  type GitHubRunnerRequest,
} from "./client"

const call = jest.fn()
const storage = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
  },
})
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: (...args: unknown[]) => call(...args) },
  transport: {
    call: () => {
      throw new Error("remote must not own runner")
    },
  },
}))
const valid: GitHubRunnerRequest = {
  repository: "owner/repo",
  workflowRef: "main",
  label: "Build",
  hostImage: `ghcr.io/a/host@sha256:${"a".repeat(64)}`,
  agentBundleImage: `ghcr.io/a/agent@sha256:${"b".repeat(64)}`,
  developmentImage: `ghcr.io/a/dev@sha256:${"c".repeat(64)}`,
  signalingUrl: "wss://signal.example/ws",
  lifetimeMinutes: 60,
}

beforeEach(() => {
  call.mockReset()
  localStorage.clear()
})

it("validates public input and rejects mutable images, credential URLs, refs, and unbounded leases", () => {
  expect(validateRunnerRequest(valid)).toEqual([])
  expect(
    validateRunnerRequest({
      ...valid,
      hostImage: "image:latest",
      signalingUrl: "wss://u:secret@host",
      workflowRef: "--help",
      lifetimeMinutes: 331,
    })
  ).toEqual(expect.arrayContaining(["hostImage", "signalingUrl", "workflowRef", "lifetimeMinutes"]))
})

it("routes every ownership operation locally even when a remote transport exists", async () => {
  await githubRunnerClient.preflight({ repository: "owner/repo", workflowRef: "main" })
  await githubRunnerClient.create(valid)
  await githubRunnerClient.list()
  await githubRunnerClient.refresh("lease")
  await githubRunnerClient.cancel("lease")
  await githubRunnerClient.pairing("lease")
  expect(call.mock.calls).toEqual([
    ["github_runner_preflight", { request: { repository: "owner/repo", workflowRef: "main" } }],
    ["github_runner_create", { request: valid }],
    ["github_runner_list", {}],
    ["github_runner_refresh", { id: "lease" }],
    ["github_runner_cancel", { id: "lease" }],
    ["github_runner_pairing", { id: "lease" }],
  ])
})

it.each([
  "owner/repo",
  "  owner/repo  ",
  "https://github.com/owner/repo",
  "https://github.com/owner/repo.git/",
])("normalizes a supported repository input %s", (input) => {
  expect(normalizeRunnerRepository(input)).toBe("owner/repo")
})

it.each([
  "http://github.com/owner/repo",
  "https://evil.test/owner/repo",
  "https://user:secret@github.com/owner/repo",
  "https://github.com/owner/repo?token=secret",
  "https://github.com/owner/repo/tree/main",
  "https://github.com/owner/repo#readme",
  "owner/..",
  "owner/repo/extra",
  "git@github.com:owner/repo.git",
])("rejects ambiguous or credential-bearing repository input %s", (input) => {
  expect(normalizeRunnerRepository(input)).toBeUndefined()
})

it("persists only reconnection ids and tolerates invalid stored metadata", () => {
  linkRunnerHost("lease", "host")
  expect(runnerHostLinks()).toEqual({ lease: "host" })
  localStorage.setItem("cognia:github-runner-host-links:v1", "not-json")
  expect(runnerHostLinks()).toEqual({})
})

it("constructs GitHub run links without trusting an arbitrary runUrl", () => {
  const lease = {
    id: "lease",
    repository: "owner/repo",
    workflowRef: "main",
    label: "Build",
    state: "ready" as const,
    createdAt: 0,
    runId: 123,
    runUrl: "javascript:alert(1)",
  }
  expect(runnerRunUrl(lease)).toBe("https://github.com/owner/repo/actions/runs/123")
  expect(runnerRunUrl({ ...lease, repository: "https://evil" })).toBeUndefined()
})

it("restores only validated public fields and never persists additional credentials", () => {
  expect(saveRunnerCreateConfig({ ...valid, token: "private" } as GitHubRunnerRequest)).toBe(true)
  expect(loadRunnerCreateConfig()).toEqual(valid)
  expect([...storage.values()].join()).not.toContain("private")
})

it.each([
  { ...valid, signalingUrl: "wss://signal.example/ws?token=private" },
  { ...valid, signalingUrl: "wss://user:private@signal.example/ws" },
  { ...valid, hostImage: "image:latest" },
  { ...valid, repository: "x".repeat(9000) },
  { ...valid, lifetimeMinutes: "60" },
  { ...valid, label: "环境".repeat(30) },
  { ...valid, repository: `owner/${"r".repeat(101)}` },
  { ...valid, hostImage: `${"a".repeat(256)}@sha256:${"a".repeat(64)}` },
])("refuses unsafe or oversized stored configuration %#", (value) => {
  expect(saveRunnerCreateConfig(valid)).toBe(true)
  expect(saveRunnerCreateConfig(value as GitHubRunnerRequest)).toBe(false)
  expect(loadRunnerCreateConfig()).toEqual(valid)
  localStorage.setItem("cognia:github-runner-create-config:v1", JSON.stringify(value))
  expect(loadRunnerCreateConfig()).toBeUndefined()
})

it("ignores corrupt storage and handles unavailable storage without blocking creation", () => {
  localStorage.setItem("cognia:github-runner-create-config:v1", "not-json")
  expect(loadRunnerCreateConfig()).toBeUndefined()
  const write = jest.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("denied")
  })
  expect(saveRunnerCreateConfig(valid)).toBe(false)
  write.mockRestore()
})
