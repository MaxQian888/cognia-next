/**
 * @jest-environment jsdom
 */

const mockEnsure = jest.fn(async () => null)

jest.mock("@/lib/terminal/host-capabilities", () => {
  const actual = jest.requireActual("@/lib/terminal/host-capabilities")
  return { ...actual, ensureHostCapabilities: () => mockEnsure() }
})

import { render, screen, act } from "@testing-library/react"

import {
  __resetHostCapabilitiesForTests,
  recordHostCapabilities,
} from "@/lib/terminal/host-capabilities"

import { useHostCapabilities } from "./use-host-capabilities"

function Probe() {
  const host = useHostCapabilities()
  return <span data-testid="shell">{host?.defaultShell ?? "unknown"}</span>
}

const HOST = {
  platform: "linux",
  defaultShell: "/bin/bash",
  availableShells: [{ path: "/bin/bash", kind: "bash" }],
  homeDir: "/root",
}

beforeEach(() => {
  __resetHostCapabilitiesForTests()
  mockEnsure.mockClear()
})

describe("useHostCapabilities", () => {
  it("reports an unknown host until one answers", () => {
    render(<Probe />)
    expect(screen.getByTestId("shell")).toHaveTextContent("unknown")
  })

  it("warms the cache on mount", () => {
    render(<Probe />)
    expect(mockEnsure).toHaveBeenCalledTimes(1)
  })

  it("shows the host that answered before it mounted", () => {
    recordHostCapabilities(HOST)
    render(<Probe />)
    expect(screen.getByTestId("shell")).toHaveTextContent("/bin/bash")
  })

  // The cache is filled by whichever frame lands first — the reattach list or
  // the probe — so a surface reading it during render would see null forever.
  it("re-renders when the host answers after mount", () => {
    render(<Probe />)
    act(() => {
      recordHostCapabilities(HOST)
    })
    expect(screen.getByTestId("shell")).toHaveTextContent("/bin/bash")
  })
})
