/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
const readTextFileMock = jest.fn<Promise<string>, [string]>(
  async (_path) => "export default { fetch() { return new Response('ok') } }"
)
const readDirMock = jest.fn<Promise<never[]>, [string]>(async (_path) => [])
const readFileMock = jest.fn<Promise<Uint8Array>, [string]>(async (_path) => new Uint8Array())
jest.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: (path: string) => readTextFileMock(path),
  readDir: (path: string) => readDirMock(path),
  readFile: (path: string) => readFileMock(path),
}))
const assertApprovedToolMock = jest.fn(async (_path: string) => undefined)
jest.mock("@/lib/sites/approved-tool", () => ({
  assertApprovedSiteProviderTool: (path: string) => assertApprovedToolMock(path),
}))

import { invoke } from "@tauri-apps/api/core"
import { uploadCloudflareWorkerVersion } from "./version-uploader"

const mockInvoke = invoke as jest.Mock

beforeEach(() => {
  mockInvoke.mockReset()
  assertApprovedToolMock.mockClear()
  readTextFileMock
    .mockReset()
    .mockResolvedValue("export default { fetch() { return new Response('ok') } }")
  readDirMock.mockReset().mockResolvedValue([])
  readFileMock.mockReset().mockResolvedValue(new Uint8Array())
})

it("uploads an already-built Worker version through a confined, provider-only Wrangler process", async () => {
  mockInvoke.mockResolvedValue({
    exit_code: 0,
    stdout: "Uploaded docs-worker",
    stderr: "",
    duration: 2,
    timed_out: false,
  })

  const result = await uploadCloudflareWorkerVersion({
    wranglerBinaryPath: "/Applications/Cognia Tools/wrangler",
    stagingRoot: "/Users/me/Library/Caches/cognia/sites/site_1",
    configPath: "/Users/me/Library/Caches/cognia/sites/site_1/wrangler.json",
    entryPath: "/workspace/dist/server/index.js",
    assetsPath: "/workspace/dist/client",
    workerName: "docs-worker",
    accountId: "account_1",
    apiToken: "provider-secret",
    tag: "cognia-version-4",
    message: "Cognia Site version 4",
    compatibilityDate: "2026-07-18",
    compatibilityFlags: ["nodejs_compat"],
  })

  expect(result.exitCode).toBe(0)
  expect(assertApprovedToolMock).toHaveBeenCalledWith("/Applications/Cognia Tools/wrangler")
  const payload = mockInvoke.mock.calls[0][1]
  expect(payload.command.argv).toEqual([
    "/Applications/Cognia Tools/wrangler",
    "versions",
    "upload",
    "/workspace/dist/server/index.js",
    "--config",
    "/Users/me/Library/Caches/cognia/sites/site_1/wrangler.json",
    "--name",
    "docs-worker",
    "--no-bundle",
    "--tag",
    "cognia-version-4",
    "--message",
    "Cognia Site version 4",
    "--compatibility-date",
    "2026-07-18",
    "--compatibility-flag",
    "nodejs_compat",
    "--assets",
    "/workspace/dist/client",
  ])
  expect(payload.command.argv.join(" ")).not.toContain("provider-secret")
  expect(payload.command.env).toMatchObject({
    CLOUDFLARE_API_TOKEN: "provider-secret",
    CLOUDFLARE_ACCOUNT_ID: "account_1",
    WRANGLER_SEND_METRICS: "false",
  })
  expect(payload.request).toMatchObject({
    writable: ["/Users/me/Library/Caches/cognia/sites/site_1"],
    network: "allowlist",
    networkHosts: ["api.cloudflare.com"],
    maxCpuSeconds: 300,
    maxMemoryMb: 2048,
  })
})

it("rejects a non-absolute Wrangler path and invalid tags before spawning", async () => {
  await expect(
    uploadCloudflareWorkerVersion({
      wranglerBinaryPath: "wrangler",
      stagingRoot: "/tmp/site",
      configPath: "/tmp/site/wrangler.json",
      entryPath: "/workspace/index.js",
      workerName: "docs",
      accountId: "account_1",
      apiToken: "token",
      tag: "bad tag",
      message: "message",
      compatibilityDate: "2026-07-18",
      compatibilityFlags: [],
    })
  ).rejects.toThrow("absolute")
  expect(mockInvoke).not.toHaveBeenCalled()
})

it("fails closed before spawning when textual upload content contains PII", async () => {
  readTextFileMock.mockResolvedValueOnce("export const owner = 'alice@example.com'")

  await expect(
    uploadCloudflareWorkerVersion({
      wranglerBinaryPath: "/Applications/Cognia Tools/wrangler",
      stagingRoot: "/tmp/site",
      configPath: "/tmp/site/wrangler.json",
      entryPath: "/tmp/site/index.js",
      workerName: "docs",
      accountId: "account_1",
      apiToken: "provider-secret",
      tag: "safe-tag",
      message: "message",
      compatibilityDate: "2026-07-18",
      compatibilityFlags: [],
    })
  ).rejects.toThrow("outbound PII gate")
  expect(mockInvoke).not.toHaveBeenCalled()
})
