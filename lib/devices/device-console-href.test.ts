import { DEVICE_PARAM, DEVICE_SECTION_PARAM, deviceConsoleHref } from "./device-console-href"

function query(href: string): URLSearchParams {
  return new URLSearchParams(href.split("?")[1] ?? "")
}

describe("deviceConsoleHref", () => {
  it("opens the console itself without a device", () => {
    expect(deviceConsoleHref()).toBe("/devices")
    expect(deviceConsoleHref(null, "files")).toBe("/devices")
  })

  it("selects a device and encodes its ref", () => {
    const href = deviceConsoleHref("ssh:ssh-1")
    expect(href.startsWith("/devices?")).toBe(true)
    expect(query(href).get(DEVICE_PARAM)).toBe("ssh:ssh-1")
    expect(query(href).has(DEVICE_SECTION_PARAM)).toBe(false)
  })

  it("carries the section to scroll to", () => {
    expect(query(deviceConsoleHref("ssh:ssh-1", "files")).get(DEVICE_SECTION_PARAM)).toBe("files")
  })
})
