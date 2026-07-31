import {
  assembleManifest,
  CONVERTED_MAIN,
  deriveRuntimeCompatibility,
  serializeManifest,
} from "./manifest"
import type { ResolvedIdentity } from "./identity"

const IDENTITY: ResolvedIdentity = {
  id: "playwright-mcp",
  name: "Playwright",
  description: "Browser automation.",
  version: "0.1.0",
  author: "Ada",
  license: "MIT",
  minAppVersion: "1.4.0",
}

describe("deriveRuntimeCompatibility", () => {
  it("marks portable contributions available everywhere", () => {
    expect(deriveRuntimeCompatibility("portable")).toEqual({
      browser: { availability: "supported", entrypoint: CONVERTED_MAIN },
      tauri: { availability: "supported", entrypoint: CONVERTED_MAIN },
      mobile: { availability: "supported", entrypoint: CONVERTED_MAIN },
    })
  })

  it.each(["host-process", "host-filesystem"] as const)(
    "blocks browser and mobile for %s contributions with a stated reason",
    (need) => {
      const map = deriveRuntimeCompatibility(need)
      expect(map.tauri?.availability).toBe("supported")
      expect(map.browser?.availability).toBe("blocked")
      expect(map.mobile?.availability).toBe("blocked")
      expect(map.browser?.reason).toBeTruthy()
      expect(map.mobile?.reason).toBe(map.browser?.reason)
    }
  )
})

describe("assembleManifest", () => {
  const manifest = assembleManifest({
    identity: IDENTITY,
    capabilities: ["mcp-server-preset"],
    need: "host-process",
    contributions: { mcpServerPresets: [{ id: "playwright" }] } as never,
  })

  it("always targets the built entry, never the TypeScript source", () => {
    expect(manifest.main).toBe("dist/index.js")
    expect(manifest.type).toBe("frontend")
  })

  it("activates at startup so manifest contributions register on enable", () => {
    expect(manifest.activationEvents).toEqual(["startup"])
  })

  it("records the host version in both minAppVersion and engines", () => {
    expect(manifest.minAppVersion).toBe("1.4.0")
    expect(manifest.engines).toEqual({ cognia: ">=1.4.0" })
  })

  it("writes the author as an object without any signing material", () => {
    expect(manifest.author).toEqual({ name: "Ada" })
    expect(JSON.stringify(manifest)).not.toContain("publicKey")
  })

  it("includes an author email only when one was resolved", () => {
    const withEmail = assembleManifest({
      identity: { ...IDENTITY, authorEmail: "ada@example.com" },
      capabilities: ["mcp-server-preset"],
      need: "portable",
      contributions: {},
    })
    expect(withEmail.author).toEqual({ name: "Ada", email: "ada@example.com" })
  })

  it("defaults permissions to an empty array", () => {
    expect(manifest.permissions).toEqual([])
  })

  it("carries the contribution array through verbatim", () => {
    expect(manifest.mcpServerPresets).toEqual([{ id: "playwright" }])
  })
})

describe("serializeManifest", () => {
  it("emits two-space JSON with a trailing newline", () => {
    const text = serializeManifest({ id: "a" } as never)
    expect(text).toBe('{\n  "id": "a"\n}\n')
  })
})
