/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { useShellContext, useShellIntelligence } from "./use-shell-intelligence"
import {
  __resetHostCapabilitiesForTests,
  recordHostCapabilities,
} from "@/lib/terminal/host-capabilities"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import { isTauri } from "@/lib/platform/detect"

const mockSettingsState: { settings: Record<string, unknown> } = {
  settings: { terminal: { autocomplete: { enabled: true }, defaultShell: "/bin/zsh" } },
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(mockSettingsState), {
    getState: () => mockSettingsState,
  }),
}))

jest.mock("@/lib/platform/detect", () => ({
  isTauri: jest.fn(() => true),
  isCapacitor: jest.fn(() => false),
}))
const mockIsTauri = jest.mocked(isTauri)

let mockRuntimeSnapshot: RuntimeSnapshot = {
  target: null,
  vaultState: "unavailable",
  connectionState: "offline",
}
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => mockRuntimeSnapshot,
}))

const messages = {
  commandNotFound: (name: string) => `not found: ${name}`,
  incompleteSyntax: () => "incomplete",
  shellUnavailable: (shell: string) => `no shell: ${shell}`,
  unsupportedShell: (shell: string) => `unsupported: ${shell}`,
}

const sources = (over: Partial<Record<"listPathExecutables" | "completePaths", unknown>> = {}) => ({
  listPathExecutables: jest.fn().mockResolvedValue([]),
  completePaths: jest.fn().mockResolvedValue([]),
  ...over,
})

/** Let the debounce, the host probes and their state updates all land. */
const settle = (ms = 400) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })

beforeEach(() => {
  __resetHostCapabilitiesForTests()
  mockSettingsState.settings = {
    terminal: { autocomplete: { enabled: true }, defaultShell: "/bin/zsh" },
  }
  mockIsTauri.mockReturnValue(true)
  mockRuntimeSnapshot = {
    target: null,
    vaultState: "unavailable",
    connectionState: "offline",
  }
  recordHostCapabilities({
    platform: "macos",
    defaultShell: "/bin/zsh",
    availableShells: [{ path: "/bin/zsh", kind: "zsh" }],
  })
})

describe("useShellContext", () => {
  it("resolves the configured shell and reports it as runnable", () => {
    const { result } = renderHook(() => useShellContext())
    expect(result.current.shell).toMatchObject({ path: "/bin/zsh", kind: "zsh" })
    expect(result.current.availability).toBe("full")
  })

  it("reports static-only when a paired Host is offline", () => {
    mockIsTauri.mockReturnValue(false)
    mockRuntimeSnapshot = {
      target: { id: "host-1", kind: "companion", platform: "web", hostKind: "cloud" },
      vaultState: "unlocked",
      connectionState: "offline",
      host: {
        compatible: true,
        operations: ["terminal_exec"],
        grants: ["terminal.open"],
      },
    }
    const { result } = renderHook(() => useShellContext())
    expect(result.current.availability).toBe("static-only")
    // Still names a shell — completion has to work on the worst client.
    expect(result.current.shell.path).toBe("/bin/zsh")
  })

  it("becomes runnable when the paired Host is online", () => {
    mockIsTauri.mockReturnValue(false)
    mockRuntimeSnapshot = {
      target: { id: "host-1", kind: "companion", platform: "web", hostKind: "cloud" },
      vaultState: "unlocked",
      connectionState: "online",
      host: {
        compatible: true,
        operations: ["terminal_exec"],
        grants: ["terminal.open"],
      },
    }
    const { result } = renderHook(() => useShellContext())
    expect(result.current.availability).toBe("full")
  })
})

describe("useShellIntelligence", () => {
  const render = (line: string | null, opts: Record<string, unknown> = {}) =>
    renderHook(() =>
      useShellIntelligence({
        line,
        cursor: line?.length ?? 0,
        cwd: "/work",
        messages,
        sources: (opts.sources ?? sources()) as never,
        ...opts,
      })
    )

  it("stays inert when the master switch is off", async () => {
    mockSettingsState.settings = { terminal: { autocomplete: { enabled: false } } }
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue(["kubectl"]) })
    const { result } = render(" kub", { sources: s })
    await settle()
    expect(result.current.enabled).toBe(false)
    expect(result.current.completions).toEqual([])
    expect(result.current.diagnostics).toEqual([])
    expect(s.listPathExecutables).not.toHaveBeenCalled()
  })

  it("completes `kub` to `kubectl`", async () => {
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue(["kubectl", "kubectx"]) })
    const { result } = render(" kub", { sources: s })
    await waitFor(() => expect(result.current.completions.length).toBeGreaterThan(0))
    expect(result.current.completions.map((c) => c.insertText)).toContain("kubectl")
  })

  it("hides results from the previous input while the next query is pending", async () => {
    const never = new Promise<string[]>(() => undefined)
    const s = sources({
      listPathExecutables: jest.fn(({ prefix }: { prefix: string }) =>
        prefix === "kub" ? Promise.resolve(["kubectl"]) : never
      ),
    })
    const { result, rerender } = renderHook(
      ({ line }: { line: string }) =>
        useShellIntelligence({
          line,
          cursor: line.length,
          cwd: "/work",
          messages,
          sources: s as never,
        }),
      { initialProps: { line: " kub" } }
    )
    await waitFor(() => expect(result.current.completions.length).toBeGreaterThan(0))

    rerender({ line: " git" })

    expect(result.current.completions).toEqual([])
  })

  it("does nothing at all outside `!` mode", async () => {
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue(["kubectl"]) })
    const { result } = render(null, { sources: s })
    await settle()
    expect(result.current.completions).toEqual([])
    expect(s.listPathExecutables).not.toHaveBeenCalled()
  })

  it("does not underline a command while it is still being typed", async () => {
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue([]) })
    const { result } = render(" abcdef", { sources: s })
    await settle(120)
    expect(result.current.diagnostics).toEqual([])
  })

  it("underlines an unknown command once the host has answered and the input is idle", async () => {
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue([]) })
    const { result } = render(" abcdef", { sources: s })
    await waitFor(() =>
      expect(result.current.diagnostics.map((d) => d.code)).toEqual(["command-not-found"])
    )
    expect(result.current.diagnostics[0].message).toBe("not found: abcdef")
  })

  it("never underlines a command the host does have", async () => {
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue(["abcdef"]) })
    const { result } = render(" abcdef", { sources: s })
    await settle()
    expect(result.current.diagnostics).toEqual([])
  })

  it("never underlines a command without a host to ask", async () => {
    mockIsTauri.mockReturnValue(false)
    mockRuntimeSnapshot = {
      target: { id: "web-standalone", kind: "standalone", platform: "web" },
      vaultState: "unlocked",
      connectionState: "online",
    }
    const s = sources({ listPathExecutables: jest.fn() })
    const { result } = render(" abcdef", { sources: s })
    await settle()
    expect(result.current.diagnostics).toEqual([])
    expect(s.listPathExecutables).not.toHaveBeenCalled()
    expect(result.current.availability).toBe("static-only")
  })

  it("resolves a builtin without asking the host at all", async () => {
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue([]) })
    render(" cd /tmp", { sources: s })
    await settle()
    expect(s.listPathExecutables).not.toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "cd" })
    )
  })

  it("dismiss() clears the list", async () => {
    const s = sources({ listPathExecutables: jest.fn().mockResolvedValue(["kubectl"]) })
    const { result } = render(" kub", { sources: s })
    await waitFor(() => expect(result.current.completions.length).toBeGreaterThan(0))
    act(() => result.current.dismiss())
    expect(result.current.completions).toEqual([])
  })

  it("reports an unavailable shell instead of silently switching to another", async () => {
    mockSettingsState.settings = {
      terminal: { autocomplete: { enabled: true }, defaultShell: "/usr/bin/fish" },
    }
    const { result } = render(" ls", { sources: sources() })
    await settle()
    expect(result.current.availability).toBe("shell-unavailable")
    expect(result.current.shell.path).toBe("/usr/bin/fish")
    expect(result.current.diagnostics[0]).toMatchObject({
      code: "shell-unavailable",
      message: "no shell: /usr/bin/fish",
    })
  })
})
