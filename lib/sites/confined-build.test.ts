/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { runConfinedSiteBuild } from "./confined-build"

const mockInvoke = invoke as jest.Mock
const mockIsTauri = isTauri as jest.Mock

beforeEach(() => {
  mockInvoke.mockReset()
  mockIsTauri.mockReturnValue(true)
})

describe("runConfinedSiteBuild", () => {
  it("always uses the local fail-closed sandbox with bounded resources and network off", async () => {
    mockInvoke.mockResolvedValue({
      exit_code: 0,
      stdout: "built",
      stderr: "",
      duration: 2,
      timed_out: false,
    })

    await expect(
      runConfinedSiteBuild({
        argv: ["pnpm", "build"],
        cwd: "/workspace/apps/site",
        writableRoots: ["/workspace/apps/site"],
        readableRoots: ["/workspace"],
        env: { NODE_ENV: "production" },
        timeoutSeconds: 600,
        maxCpuSeconds: 600,
        maxMemoryMb: 4096,
      })
    ).resolves.toMatchObject({ exitCode: 0, stdout: "built" })

    expect(mockInvoke).toHaveBeenCalledWith("sandbox_exec", {
      tool: "sandbox_bash",
      command: {
        argv: ["pnpm", "build"],
        cwd: "/workspace/apps/site",
        env: { NODE_ENV: "production" },
        stdin: null,
        timeout: 600,
      },
      request: {
        writable: ["/workspace/apps/site"],
        readable: ["/workspace"],
        targetFiles: [],
        maxCpuSeconds: 600,
        maxMemoryMb: 4096,
        network: "off",
        networkHosts: [],
      },
    })
  })

  it("allows only an explicit, normalized build-network host list", async () => {
    mockInvoke.mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration: 1,
      timed_out: false,
    })
    await runConfinedSiteBuild({
      argv: ["pnpm", "install", "--frozen-lockfile"],
      cwd: "/workspace",
      writableRoots: ["/workspace"],
      readableRoots: [],
      networkHosts: ["REGISTRY.NPMJS.ORG", "registry.npmjs.org"],
    })
    expect(mockInvoke.mock.calls[0][1].request).toMatchObject({
      network: "allowlist",
      networkHosts: ["registry.npmjs.org"],
    })
  })

  it("refuses provider credentials in the build environment", async () => {
    await expect(
      runConfinedSiteBuild({
        argv: ["pnpm", "build"],
        cwd: "/workspace",
        writableRoots: ["/workspace"],
        readableRoots: [],
        env: { CLOUDFLARE_API_TOKEN: "secret" },
      })
    ).rejects.toThrow("credential-like")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("fails closed outside the local Tauri host", async () => {
    mockIsTauri.mockReturnValue(false)
    await expect(
      runConfinedSiteBuild({
        argv: ["pnpm", "build"],
        cwd: "/workspace",
        writableRoots: ["/workspace"],
        readableRoots: [],
      })
    ).rejects.toThrow("local Tauri")
  })
})
