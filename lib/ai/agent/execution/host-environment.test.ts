import type { HostProfile } from "@/lib/platform/capabilities"

const detectHostProfile = jest.fn<HostProfile, []>(() => "web-standalone")
jest.mock("@/lib/platform/capabilities", () => ({
  detectHostProfile: () => detectHostProfile(),
}))

import {
  agentExecutionEnvironmentForProfile,
  agentHostAvailable,
  resolveAgentExecutionEnvironment,
} from "./host-environment"

describe("agentExecutionEnvironmentForProfile", () => {
  it("maps the desktop shell to the Tauri sidecar", () => {
    expect(agentExecutionEnvironmentForProfile("desktop")).toEqual({
      isTauri: true,
      isHeadlessHost: false,
      hostProfile: "desktop",
    })
  })

  it("maps the headless brain to the headless agent host, not the web renderer", () => {
    const env = agentExecutionEnvironmentForProfile("headless")
    expect(env.isHeadlessHost).toBe(true)
    expect(env.isTauri).toBe(false)
    expect(env.pairedHost).toBeUndefined()
  })

  it.each<HostProfile>(["mobile-companion", "cloud-companion"])(
    "marks %s as a paired host: the rail runs on the host's sidecar",
    (profile) => {
      const env = agentExecutionEnvironmentForProfile(profile)
      expect(env).toEqual({
        isTauri: false,
        isHeadlessHost: false,
        pairedHost: true,
        hostProfile: profile,
      })
    }
  )

  it("leaves a standalone browser with no host at all", () => {
    expect(agentExecutionEnvironmentForProfile("web-standalone")).toEqual({
      isTauri: false,
      isHeadlessHost: false,
      hostProfile: "web-standalone",
    })
  })
})

describe("agentHostAvailable", () => {
  it("is true for desktop, headless and paired hosts, false for a standalone browser", () => {
    expect(agentHostAvailable(agentExecutionEnvironmentForProfile("desktop"))).toBe(true)
    expect(agentHostAvailable(agentExecutionEnvironmentForProfile("headless"))).toBe(true)
    expect(agentHostAvailable(agentExecutionEnvironmentForProfile("mobile-companion"))).toBe(true)
    expect(agentHostAvailable(agentExecutionEnvironmentForProfile("cloud-companion"))).toBe(true)
    expect(agentHostAvailable(agentExecutionEnvironmentForProfile("web-standalone"))).toBe(false)
  })

  it("keeps working for callers that still hand-build the two legacy flags", () => {
    expect(agentHostAvailable({ isTauri: true, isHeadlessHost: false })).toBe(true)
    expect(agentHostAvailable({ isTauri: false, isHeadlessHost: true })).toBe(true)
    expect(agentHostAvailable({ isTauri: false, isHeadlessHost: false })).toBe(false)
  })
})

describe("resolveAgentExecutionEnvironment", () => {
  it("derives the environment from the detected host profile, not from a webview marker", () => {
    detectHostProfile.mockReturnValue("headless")
    expect(resolveAgentExecutionEnvironment().isHeadlessHost).toBe(true)
    detectHostProfile.mockReturnValue("cloud-companion")
    expect(resolveAgentExecutionEnvironment().pairedHost).toBe(true)
    detectHostProfile.mockReturnValue("desktop")
    expect(resolveAgentExecutionEnvironment().isTauri).toBe(true)
  })
})
