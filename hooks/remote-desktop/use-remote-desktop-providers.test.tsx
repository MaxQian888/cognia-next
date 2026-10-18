import { act, renderHook } from "@testing-library/react"

import {
  __resetRemoteDesktopProvidersForTests,
  registerRemoteDesktopProvider,
} from "@/lib/remote-desktop/provider-registry"

import { useRemoteDesktopProviders } from "./use-remote-desktop-providers"

afterEach(() => __resetRemoteDesktopProvidersForTests())

describe("useRemoteDesktopProviders", () => {
  it("follows registrations and disposals", () => {
    const { result } = renderHook(() => useRemoteDesktopProviders())
    expect(result.current).toHaveLength(0)
    let dispose = () => {}
    act(() => {
      dispose = registerRemoteDesktopProvider({
        providerId: "p.vnc",
        pluginId: "p",
        firstParty: true,
        definition: {
          id: "vnc",
          name: "VNC",
          integrationMode: "embedded",
          adapter: "vnc",
          defaultPort: 5900,
          capabilities: { viewOnlyPassword: true },
          viewer: { kind: "react", component: () => null },
        },
      })
    })
    expect(result.current.map((entry) => entry.providerId)).toEqual(["p.vnc"])
    act(() => dispose())
    expect(result.current).toHaveLength(0)
  })
})
