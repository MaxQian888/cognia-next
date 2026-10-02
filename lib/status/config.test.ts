import { STATUS_PAGE_URL } from "../constants/external-urls"
import {
  DEFAULT_STATUS_API_BASE,
  parseStatusRuntimeMeta,
  parseStatusTokenFragment,
  resolveStatusRuntime,
  statusApiUrl,
  statusIncidentPageUrl,
  statusTokenPageUrl,
  validateStatusUrl,
} from "./config"

const TOKEN = "b".repeat(43)

describe("status URL validation", () => {
  it("accepts https and loopback http only when allowed", () => {
    expect(validateStatusUrl("https://status.example.com/status/")).toBe(
      "https://status.example.com/status/"
    )
    expect(validateStatusUrl("http://status.example.com")).toBeNull()
    expect(validateStatusUrl("http://localhost:8787/api/status/v1")).toBeNull()
    expect(
      validateStatusUrl("http://localhost:8787/api/status/v1", { allowLoopbackHttp: true })
    ).toBe("http://localhost:8787/api/status/v1")
    expect(validateStatusUrl("http://evil.example", { allowLoopbackHttp: true })).toBeNull()
    expect(validateStatusUrl("https://user:pw@status.example.com")).toBeNull()
    expect(validateStatusUrl("javascript:alert(1)")).toBeNull()
  })
})

describe("runtime resolution", () => {
  it("uses the injected same-origin API on the primary host", () => {
    const runtime = resolveStatusRuntime({
      metaContent: JSON.stringify({ mode: "primary", apiBase: "/api/status/v1/" }),
    })
    expect(runtime).toEqual({
      mode: "primary",
      apiBase: "/api/status/v1",
      primaryPageUrl: STATUS_PAGE_URL,
      allowsConsentWrites: true,
    })
  })

  it("disables consent writes on the mirror", () => {
    const runtime = resolveStatusRuntime({
      metaContent: JSON.stringify({ mode: "mirror", apiBase: "/api/status/v1" }),
    })
    expect(runtime.mode).toBe("mirror")
    expect(runtime.allowsConsentWrites).toBe(false)
  })

  it("ignores meta that points off-origin", () => {
    expect(
      parseStatusRuntimeMeta(JSON.stringify({ mode: "primary", apiBase: "https://evil.example" }))
    ).toBeNull()
    expect(
      parseStatusRuntimeMeta(JSON.stringify({ mode: "primary", apiBase: "//evil.example/x" }))
    ).toBeNull()
    expect(parseStatusRuntimeMeta(JSON.stringify({ mode: "admin", apiBase: "/api" }))).toBeNull()
    expect(parseStatusRuntimeMeta("{not json")).toBeNull()
  })

  it("reads the official API from inside the app and never posts consent there", () => {
    const runtime = resolveStatusRuntime()
    expect(runtime.mode).toBe("app")
    expect(runtime.apiBase).toBe(DEFAULT_STATUS_API_BASE)
    expect(runtime.allowsConsentWrites).toBe(false)
  })

  it("accepts a validated self-host override and rejects an insecure one", () => {
    expect(
      resolveStatusRuntime({ apiOverride: "https://status.self.example/api/status/v1" }).apiBase
    ).toBe("https://status.self.example/api/status/v1")
    expect(resolveStatusRuntime({ apiOverride: "http://status.self.example" }).apiBase).toBe(
      DEFAULT_STATUS_API_BASE
    )
    expect(
      resolveStatusRuntime({
        apiOverride: "http://127.0.0.1:8787/api/status/v1",
        allowLoopbackHttp: true,
      }).apiBase
    ).toBe("http://127.0.0.1:8787/api/status/v1")
  })
})

describe("status links", () => {
  it("joins API paths", () => {
    expect(statusApiUrl("/api/status/v1/", "snapshot?range=7d")).toBe(
      "/api/status/v1/snapshot?range=7d"
    )
  })

  it("deep-links incidents by query and tokens by fragment", () => {
    expect(statusIncidentPageUrl(STATUS_PAGE_URL, "inc_1")).toBe(
      "https://status.cognia.cn/status/?incident=inc_1"
    )
    const tokenUrl = statusTokenPageUrl(STATUS_PAGE_URL, "confirm", TOKEN)
    expect(tokenUrl).toBe(`https://status.cognia.cn/status/#action=confirm&token=${TOKEN}`)
    expect(parseStatusTokenFragment(new URL(tokenUrl).hash)).toEqual({
      action: "confirm",
      token: TOKEN,
    })
  })

  it("rejects malformed token fragments", () => {
    expect(parseStatusTokenFragment("")).toBeNull()
    expect(parseStatusTokenFragment(`#action=delete&token=${TOKEN}`)).toBeNull()
    expect(parseStatusTokenFragment("#action=confirm&token=short")).toBeNull()
  })
})
