import type { EffectiveValue } from "@/lib/config/effective-value"
import type { EffectiveConfigValue, ImConfigSource } from "@/lib/connectors/effective-config"

/**
 * Compile-time guards. `EffectiveValue` has no runtime surface of its own, so
 * what is worth pinning is the relationship it exists for: the IM facade's
 * `EffectiveConfigValue<T>` must stay exactly this shape specialised to
 * `ImConfigSource`, or the two drift back into separate resolvers.
 */
type Assert<T extends true> = T
type Exact<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false

type _ImIsASpecialisation = Assert<
  Exact<EffectiveConfigValue<string>, EffectiveValue<string, ImConfigSource>>
>

// A `source` outside the domain's union must not type-check.
const _rejectsUnknownSource: EffectiveValue<number, ImConfigSource> = {
  requested: undefined,
  effective: 1,
  // @ts-expect-error "invented-layer" is not an ImConfigSource
  source: "invented-layer",
}

describe("EffectiveValue", () => {
  it("carries the requested value alongside the winner", () => {
    const value: EffectiveValue<string, ImConfigSource> = {
      requested: "gpt-5",
      effective: "claude-opus-5",
      source: "adapter-default",
    }

    // The point of keeping both: a UI can say "you asked for X, Y is in use".
    expect(value.requested).toBe("gpt-5")
    expect(value.effective).toBe("claude-opus-5")
    expect(value.blockedReason).toBeUndefined()
  })

  it("distinguishes outranked from refused", () => {
    const outranked: EffectiveValue<string | undefined, ImConfigSource> = {
      requested: "gpt-5",
      effective: "claude-opus-5",
      source: "conversation-override",
    }
    const refused: EffectiveValue<string | undefined, ImConfigSource> = {
      requested: "gpt-5",
      effective: undefined,
      source: "target-managed",
      blockedReason: "managed_by_target",
    }

    expect("blockedReason" in outranked).toBe(false)
    expect(refused.blockedReason).toBe("managed_by_target")
  })
})
