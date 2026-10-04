import {
  newSshHostSettingsHref,
  sshHostSettingsHref,
  SSH_HOST_PARAM,
  TERMINAL_PANEL_IDS,
  TERMINAL_PANEL_PARAM,
  terminalSettingsHref,
} from "./terminal-settings-link"

function params(href: string): URLSearchParams {
  expect(href.startsWith("/settings?")).toBe(true)
  return new URLSearchParams(href.slice("/settings?".length))
}

describe("terminalSettingsHref", () => {
  it("opens the section on its default panel when none is named", () => {
    const query = params(terminalSettingsHref())
    expect(query.get("section")).toBe("terminal")
    expect(query.has(TERMINAL_PANEL_PARAM)).toBe(false)
  })

  it("names the panel when one is given", () => {
    expect(params(terminalSettingsHref("host")).get(TERMINAL_PANEL_PARAM)).toBe("host")
  })
})

describe("sshHostSettingsHref", () => {
  it("opens the SSH panel and the named host", () => {
    const query = params(sshHostSettingsHref("ssh-3"))
    expect(query.get("section")).toBe("terminal")
    expect(query.get(TERMINAL_PANEL_PARAM)).toBe("ssh")
    expect(query.get(SSH_HOST_PARAM)).toBe("ssh-3")
  })

  it("opens just the SSH panel without a host", () => {
    expect(params(sshHostSettingsHref()).has(SSH_HOST_PARAM)).toBe(false)
    expect(params(sshHostSettingsHref(null)).get(TERMINAL_PANEL_PARAM)).toBe("ssh")
  })

  it("encodes an id rather than splicing it into the query", () => {
    expect(params(sshHostSettingsHref("a&b=c")).get(SSH_HOST_PARAM)).toBe("a&b=c")
  })
})

describe("newSshHostSettingsHref", () => {
  it("asks the SSH panel to start a new host", () => {
    expect(params(newSshHostSettingsHref()).get(SSH_HOST_PARAM)).toBe("new")
  })
})

describe("TERMINAL_PANEL_IDS", () => {
  it("lists each panel once", () => {
    expect(new Set(TERMINAL_PANEL_IDS).size).toBe(TERMINAL_PANEL_IDS.length)
    expect(TERMINAL_PANEL_IDS).toContain("ssh")
  })
})
