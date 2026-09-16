/**
 * @jest-environment jsdom
 */
/**
 * Trust tier comes from install provenance, never from the manifest — a plugin
 * that could name its own tier would name the highest one, and tier decides who
 * gets to see and rewrite a payload first.
 */

import { resolveInterceptorTrustTier, trustTierForSource } from "./trust"
import { usePluginStore } from "@/stores/plugin-runtime"

beforeEach(() => {
  usePluginStore.setState({ plugins: {} } as never)
})

describe("trustTierForSource", () => {
  it("maps bundled plugins to the outermost tier", () => {
    expect(trustTierForSource("builtin")).toBe("builtin")
  })

  it("maps a marketplace install to the middle tier", () => {
    // Signature verification proves provenance, not safety — hence a middle
    // tier rather than parity with in-tree code.
    expect(trustTierForSource("marketplace")).toBe("verified")
  })

  it("maps sideloaded, cloned and dev sources to community", () => {
    expect(trustTierForSource("local")).toBe("community")
    expect(trustTierForSource("git")).toBe("community")
    expect(trustTierForSource("dev")).toBe("community")
  })

  it("treats an unknown provenance as the LEAST trusted answer", () => {
    expect(trustTierForSource(undefined)).toBe("community")
  })
})

describe("resolveInterceptorTrustTier", () => {
  it("reads the store row", () => {
    usePluginStore.setState({
      plugins: { p1: { id: "p1", status: "enabled", source: "builtin" } },
    } as never)
    expect(resolveInterceptorTrustTier("p1")).toBe("builtin")
  })

  it("gives a plugin with no row yet the least trust, not the most", () => {
    expect(resolveInterceptorTrustTier("not-installed")).toBe("community")
  })
})
