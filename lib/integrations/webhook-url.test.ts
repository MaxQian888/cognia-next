import {
  isNonPublicHostname,
  isPubliclyDeliverableUrl,
  normalizePublicBaseUrl,
  toPublicWebhookUrl,
} from "./webhook-url"

describe("isNonPublicHostname", () => {
  it.each([
    "localhost",
    "app.localhost",
    "printer.local",
    "db.internal",
    "127.0.0.1",
    "10.2.3.4",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "[::1]",
    "[fd00::1]",
    "[fe80::1]",
  ])("refuses %s", (host) => {
    expect(isNonPublicHostname(host)).toBe(true)
  })

  it.each(["hooks.example.com", "8.8.8.8", "172.32.0.1", "[2001:db8::1]"])("accepts %s", (host) => {
    expect(isNonPublicHostname(host)).toBe(false)
  })
})

describe("isPubliclyDeliverableUrl", () => {
  it("accepts a public https URL", () => {
    expect(isPubliclyDeliverableUrl("https://hooks.example.com/integration/r1")).toBe(true)
  })

  it("refuses the loopback listener, plain http, credentials and junk", () => {
    expect(isPubliclyDeliverableUrl("http://127.0.0.1:4455/integration/r1")).toBe(false)
    expect(isPubliclyDeliverableUrl("https://127.0.0.1/integration/r1")).toBe(false)
    expect(isPubliclyDeliverableUrl("http://hooks.example.com/integration/r1")).toBe(false)
    expect(isPubliclyDeliverableUrl("https://u:p@hooks.example.com/x")).toBe(false)
    expect(isPubliclyDeliverableUrl("not a url")).toBe(false)
    expect(isPubliclyDeliverableUrl(undefined)).toBe(false)
  })
})

describe("normalizePublicBaseUrl", () => {
  it("assumes https for a bare host and drops query, fragment and trailing slashes", () => {
    expect(normalizePublicBaseUrl(" hooks.example.com/ ")).toBe("https://hooks.example.com")
    expect(normalizePublicBaseUrl("https://proxy.example.com/cognia/?x=1#y")).toBe(
      "https://proxy.example.com/cognia"
    )
  })

  it("refuses what no sender could reach", () => {
    expect(normalizePublicBaseUrl("http://hooks.example.com")).toBeUndefined()
    expect(normalizePublicBaseUrl("localhost:8080")).toBeUndefined()
    expect(normalizePublicBaseUrl("")).toBeUndefined()
    expect(normalizePublicBaseUrl(undefined)).toBeUndefined()
  })
})

describe("toPublicWebhookUrl", () => {
  it("puts the listener's route path on the public base", () => {
    expect(
      toPublicWebhookUrl("http://127.0.0.1:4455/integration/r1", "https://proxy.example.com/cognia")
    ).toBe("https://proxy.example.com/cognia/integration/r1")
  })

  it("is undefined without a usable base or listener URL", () => {
    expect(toPublicWebhookUrl("http://127.0.0.1:4455/integration/r1", undefined)).toBeUndefined()
    expect(toPublicWebhookUrl("http://127.0.0.1:4455/integration/r1", "localhost")).toBeUndefined()
    expect(toPublicWebhookUrl(undefined, "https://hooks.example.com")).toBeUndefined()
  })
})
