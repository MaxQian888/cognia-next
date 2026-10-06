import type { AcpVendorProfile } from "./vendor-profile"
import { resolveAcpVendorProfile } from "./vendor-profile"
import { ACP_VENDOR_PROFILES } from "./vendor-profiles"

const resolve = (config: Parameters<typeof resolveAcpVendorProfile>[0]) =>
  resolveAcpVendorProfile(config, ACP_VENDOR_PROFILES)?.id

describe("resolveAcpVendorProfile", () => {
  it("selects a profile by preset id", () => {
    expect(resolve({ metadata: { preset: "kimi" } })).toBe("kimi")
    expect(resolve({ metadata: { preset: "opencode-acp" } })).toBe("opencode-acp")
  })

  it("selects a profile by executable basename, with or without .exe, on either separator", () => {
    expect(resolve({ process: { command: "/usr/local/bin/goose" } })).toBe("goose")
    expect(resolve({ process: { command: "C:\\Tools\\Devin.EXE" } })).toBe("devin")
    expect(resolve({ process: { command: "cline" } })).toBe("cline")
    expect(resolve({ process: { command: "/opt/opencode" } })).toBe("opencode-acp")
  })

  it("prefers the preset over the executable", () => {
    expect(resolve({ metadata: { preset: "qoder" }, process: { command: "/bin/kimi" } })).toBe(
      "qoder"
    )
  })

  it("leaves a plain ACP agent without a profile", () => {
    expect(resolve(undefined)).toBeUndefined()
    expect(resolve({ metadata: { preset: "gemini" }, process: { command: "gemini" } })).toBe(
      undefined
    )
    expect(resolve({ process: { command: "/bin/kimi-helper" } })).toBeUndefined()
    expect(resolve({ process: { command: "/bin/notgoose" } })).toBeUndefined()
  })

  it("resolves against the profiles it is given", () => {
    const custom: AcpVendorProfile = { id: "acme", label: "Acme", commandNames: ["acme+cli"] }
    expect(resolveAcpVendorProfile({ process: { command: "/x/acme+cli" } }, [custom])).toBe(custom)
    expect(resolveAcpVendorProfile({ metadata: { preset: "kimi" } }, [custom])).toBeUndefined()
  })
})
