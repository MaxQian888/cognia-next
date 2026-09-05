import { renderHook } from "@testing-library/react"

import { useHostAdminReach, useHostAdminReachForCommand } from "./use-host-admin-reach"

const profile = jest.fn<string, []>(() => "desktop")
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => profile(),
}))

describe("useHostAdminReach", () => {
  it("is available on the desktop for every requirement", () => {
    profile.mockReturnValue("desktop")
    expect(renderHook(() => useHostAdminReach("desktop-shell")).result.current.available).toBe(true)
    expect(
      renderHook(() => useHostAdminReachForCommand("companion_tunnel_start")).result.current
        .available
    ).toBe(true)
  })

  it("names the block from a companion shell", () => {
    profile.mockReturnValue("cloud-companion")
    expect(renderHook(() => useHostAdminReach("desktop-shell")).result.current).toEqual({
      available: false,
      block: "needs-desktop-shell",
    })
    expect(renderHook(() => useHostAdminReach("host-admin")).result.current.available).toBe(true)
  })
})
