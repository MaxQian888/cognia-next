/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import {
  __resetContributedPiPackagesForTesting,
  registerContributedPiPackage,
  unregisterContributedPiPackagesByPlugin,
} from "@/lib/plugin/pi-packages/registry"
import {
  useContributedPiPackageEntries,
  useContributedPiPackages,
} from "./use-contributed-pi-packages"

const mockExecuteShell = jest.fn()
jest.mock("@/lib/shell/exec", () => ({
  executeShell: (...args: unknown[]) => mockExecuteShell(...args),
}))
jest.mock("@/lib/platform/os", () => ({ detectOsFamily: () => "macos" }))
const mockGetState = jest.fn(() => ({ plugins: {} }))
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: () => mockGetState() },
}))

describe("useContributedPiPackages", () => {
  beforeEach(() => {
    __resetContributedPiPackagesForTesting()
    mockExecuteShell.mockReset()
    mockExecuteShell.mockResolvedValue({ exitCode: 1, timedOut: false })
  })

  it("lists entries live and narrows by plugin", () => {
    const { result } = renderHook(() => useContributedPiPackageEntries("a"))
    expect(result.current).toEqual([])
    act(() => {
      registerContributedPiPackage(
        { id: "one", name: "One", path: "." },
        {
          pluginId: "a",
          installRoot: "/p/a",
        }
      )
      registerContributedPiPackage(
        { id: "two", name: "Two", path: "." },
        {
          pluginId: "b",
          installRoot: "/p/b",
        }
      )
    })
    expect(result.current.map((entry) => entry.ref)).toEqual(["a/one"])
  })

  it("resolves each package, keeping typed refusals per row", async () => {
    registerContributedPiPackage(
      {
        id: "latex",
        name: "LaTeX",
        path: "pi",
        prepare: { program: "npm", args: ["ci"], marker: "pi/node_modules/.lock" },
      },
      { pluginId: "latex-workbench", installRoot: "/p/latex-workbench" }
    )
    registerContributedPiPackage(
      { id: "inside", name: "Inside", path: "." },
      {
        pluginId: "builtin-one",
        installRoot: "builtin://builtin-one",
      }
    )
    const { result } = renderHook(() => useContributedPiPackages())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const [latex, builtin] = result.current.packages
    expect(latex.resolved?.packageDir).toBe("/p/latex-workbench/pi")
    expect(latex.resolved?.prepareState).toBe("missing")
    expect(builtin.resolved).toBeNull()
    expect(builtin.error?.code).toBe("not-on-disk")
  })

  it("re-probes on refresh and follows unregistration", async () => {
    registerContributedPiPackage(
      {
        id: "latex",
        name: "LaTeX",
        path: "pi",
        prepare: { program: "npm", args: ["ci"], marker: "pi/m" },
      },
      { pluginId: "latex-workbench", installRoot: "/p/latex-workbench" }
    )
    const { result } = renderHook(() => useContributedPiPackages("latex-workbench"))
    await waitFor(() => expect(result.current.packages[0]?.resolved?.prepareState).toBe("missing"))

    mockExecuteShell.mockResolvedValue({ exitCode: 0, timedOut: false })
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.packages[0]?.resolved?.prepareState).toBe("prepared"))

    act(() => {
      unregisterContributedPiPackagesByPlugin("latex-workbench")
    })
    expect(result.current.packages).toEqual([])
  })

  it("reports an unexpected failure as resolution-failed, never as not-found", async () => {
    mockGetState.mockImplementationOnce(() => {
      throw new Error("store exploded")
    })
    registerContributedPiPackage(
      {
        id: "cfg",
        name: "Cfg",
        path: ".",
        hostedSession: {
          extensions: ["x.ts"],
          env: [{ name: "MODE", from: { config: "mode" } }],
        },
      },
      { pluginId: "cfg-plugin", installRoot: "/p/cfg-plugin" }
    )
    const { result } = renderHook(() => useContributedPiPackages("cfg-plugin"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const [view] = result.current.packages
    expect(view.error?.code).toBe("resolution-failed")
    expect(view.error?.message).toContain("store exploded")
  })
})
