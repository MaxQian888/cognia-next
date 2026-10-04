/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

import { sshAddress, SshHostSummary, sshHostIssue } from "./ssh-host-summary"

function host(id: string, overrides: Partial<SshHostProfile> = {}): SshHostProfile {
  return {
    id,
    name: id,
    host: `${id}.example.com`,
    port: 22,
    username: "deploy",
    authMethod: "agent",
    ...overrides,
  }
}

describe("sshAddress", () => {
  it("writes the port only when it is not the default", () => {
    expect(sshAddress(host("a"))).toBe("deploy@a.example.com")
    expect(sshAddress(host("a", { port: 2222 }))).toBe("deploy@a.example.com:2222")
  })

  it("drops an empty user instead of printing a stray @", () => {
    expect(sshAddress(host("a", { username: "" }))).toBe("a.example.com")
  })
})

describe("sshHostIssue", () => {
  it("is null for a host Connect would accept", () => {
    expect(sshHostIssue(host("a"), [host("a")])).toBeNull()
  })

  it("names the first invalid field", () => {
    expect(sshHostIssue(host("a", { host: "" }), [])).toEqual({ kind: "invalid", field: "host" })
  })

  it("reports a jump chain that cannot be walked", () => {
    expect(sshHostIssue(host("a", { jumpHostId: "gone" }), [])).toEqual({ kind: "chainBroken" })
  })

  it("reports a password host with nothing stored", () => {
    expect(sshHostIssue(host("a", { authMethod: "password" }), [])).toEqual({
      kind: "passwordMissing",
    })
    expect(sshHostIssue(host("a", { authMethod: "password", credentialRef: "a" }), [])).toBeNull()
  })
})

describe("SshHostSummary", () => {
  it("states the name, address and auth method", () => {
    render(<SshHostSummary profile={host("prod", { port: 2200 })} allProfiles={[]} />)
    const summary = screen.getByTestId("ssh-host-summary")
    expect(summary).toHaveTextContent("prod")
    expect(summary).toHaveTextContent("deploy@prod.example.com:2200")
    expect(summary).toHaveTextContent("auth.agent")
  })

  it("names the bastions a host goes through, outermost first", () => {
    const outer = host("outer", { name: "Outer" })
    const inner = host("inner", { name: "Inner", jumpHostId: "outer" })
    const target = host("target", { jumpHostId: "inner" })
    render(<SshHostSummary profile={target} allProfiles={[outer, inner, target]} />)
    expect(screen.getByTestId("ssh-host-summary-via")).toHaveTextContent(
      'via:{"names":"Outer → Inner"}'
    )
  })

  it("counts only the forwards that will run", () => {
    render(
      <SshHostSummary
        profile={host("a", {
          localForwards: [
            { id: "l1", localPort: 1, remoteHost: "x", remotePort: 1, enabled: true },
            { id: "l2", localPort: 2, remoteHost: "x", remotePort: 2, enabled: false },
          ],
          remoteForwards: [
            { id: "r1", remotePort: 3, localHost: "localhost", localPort: 3, enabled: true },
          ],
        })}
        allProfiles={[]}
      />
    )
    expect(screen.getByTestId("ssh-host-summary-forwards")).toHaveTextContent(
      'forwards:{"count":2}'
    )
  })

  it("says why Connect would fail, before anyone clicks it", () => {
    render(<SshHostSummary profile={host("a", { authMethod: "password" })} allProfiles={[]} />)
    expect(screen.getByTestId("ssh-host-summary-issue")).toHaveAttribute(
      "data-issue",
      "passwordMissing"
    )
  })

  it("shows nothing alarming for a ready host", () => {
    render(<SshHostSummary profile={host("a")} allProfiles={[]} />)
    expect(screen.queryByTestId("ssh-host-summary-issue")).toBeNull()
    expect(screen.queryByTestId("ssh-host-summary-via")).toBeNull()
  })
})
