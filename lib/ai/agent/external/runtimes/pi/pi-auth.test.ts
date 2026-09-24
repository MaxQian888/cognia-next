/** @jest-environment node */
import {
  PI_AUTH_FORBIDDEN_FLAGS,
  PI_AUTH_FORBIDDEN_SUBCOMMANDS,
  buildPiAuthCheckArgs,
  classifyPiAuthProbe,
  parsePiModelListing,
  parsePiModelProviders,
  reconcilePiAuthVerdict,
} from "./pi-auth"

// Every fixture below is a verbatim capture from Pi 0.84.1 on macOS, not a
// hand-written approximation. The point of the module is that Pi's real
// behaviour is surprising, so invented fixtures would test the wrong thing.

describe("buildPiAuthCheckArgs", () => {
  it("always pins --json and the read-only --no-refresh", () => {
    expect(buildPiAuthCheckArgs({ provider: "deepseek" })).toEqual([
      "auth",
      "check",
      "--provider",
      "deepseek",
      "--json",
      "--no-refresh",
    ])
  })

  it("supports the --model selector Pi resolves to a provider itself", () => {
    expect(buildPiAuthCheckArgs({ model: "deepseek-chat" })).toEqual([
      "auth",
      "check",
      "--model",
      "deepseek-chat",
      "--json",
      "--no-refresh",
    ])
  })

  it("never emits a credential-printing subcommand or flag", () => {
    for (const target of [{ provider: "openai" }, { model: "gpt-5" }] as const) {
      const args = buildPiAuthCheckArgs(target)
      for (const banned of [...PI_AUTH_FORBIDDEN_SUBCOMMANDS, ...PI_AUTH_FORBIDDEN_FLAGS]) {
        expect(args).not.toContain(banned)
      }
      // `check` is the only subcommand that reports without emitting a secret.
      expect(args[1]).toBe("check")
    }
  })
})

describe("classifyPiAuthProbe", () => {
  it("reads a configured provider", () => {
    expect(
      classifyPiAuthProbe({
        stdout: '{"status":"ready","provider":"deepseek","authType":"api_key"}\n',
        exitCode: 0,
      })
    ).toEqual({ status: "ready", provider: "deepseek", authType: "api_key" })
  })

  it("reads a provider with no credentials", () => {
    expect(
      classifyPiAuthProbe({
        stdout:
          '{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}',
        exitCode: 1,
      })
    ).toEqual({
      status: "not_ready",
      provider: "anthropic",
      reason: "credentials_not_configured",
    })
  })

  it("reads an unknown provider as not_ready, not as a Cognia error", () => {
    expect(
      classifyPiAuthProbe({
        stdout: '{"status":"not_ready","provider":"__nope__","reason":"provider_not_found"}',
        exitCode: 1,
      })
    ).toEqual({ status: "not_ready", provider: "__nope__", reason: "provider_not_found" })
  })

  it("reads an unresolvable model as invalid", () => {
    expect(
      classifyPiAuthProbe({
        stdout: '{"status":"invalid","provider":"__nope__","reason":"invalid_state"}',
        exitCode: 2,
      })
    ).toEqual({ status: "invalid", provider: "__nope__", reason: "invalid_state" })
  })

  it("does not let the exit code override the reported status", () => {
    // Pi's own mapping is ready->0, not_ready->1, invalid->2, but an argument
    // parse failure exits 1 and a usage error exits 2. If the exit code led,
    // both would be misreported as a credential problem. The JSON wins.
    const verdict = classifyPiAuthProbe({
      stdout: '{"status":"ready","provider":"deepseek","authType":"api_key"}',
      exitCode: 2,
    })
    expect(verdict.status).toBe("ready")
  })

  it("calls a usage error unreadable rather than unauthenticated", () => {
    // Verbatim: `pi auth check --json --no-refresh` with no selector. Note it
    // exits 2 and writes prose to stderr, leaving stdout completely empty even
    // though --json was asked for.
    expect(classifyPiAuthProbe({ stdout: "", exitCode: 2 })).toEqual({
      status: "unreadable",
      provider: null,
      unreadableReason: "no_output",
    })
  })

  it("calls non-JSON stdout unreadable", () => {
    expect(
      classifyPiAuthProbe({
        stdout: "Error: Auth checks require --provider <provider> or --model <model>\n",
        exitCode: 1,
      })
    ).toEqual({ status: "unreadable", provider: null, unreadableReason: "not_json" })
  })

  it("calls a JSON document of the wrong shape unreadable", () => {
    expect(classifyPiAuthProbe({ stdout: '{"ok":true}', exitCode: 0 })).toEqual({
      status: "unreadable",
      provider: null,
      unreadableReason: "unknown_shape",
    })
  })

  it("survives a chatty environment that prepends noise", () => {
    const verdict = classifyPiAuthProbe({
      stdout: [
        "(node:512) [DEP0040] DeprecationWarning: punycode is deprecated",
        '{"status":"ready","provider":"deepseek","authType":"api_key"}',
      ].join("\n"),
      exitCode: 0,
    })
    expect(verdict).toEqual({ status: "ready", provider: "deepseek", authType: "api_key" })
  })

  it("drops a status or reason Pi did not define", () => {
    // A future Pi could add a vocabulary member. Passing it through untouched
    // would put an unlocalisable raw enum on screen; dropping the whole verdict
    // would hide a perfectly good one. Unknown status -> unreadable, unknown
    // reason -> keep the status, drop the reason.
    expect(classifyPiAuthProbe({ stdout: '{"status":"pending","provider":"x"}' }).status).toBe(
      "unreadable"
    )
    expect(
      classifyPiAuthProbe({ stdout: '{"status":"not_ready","provider":"x","reason":"brand_new"}' })
    ).toEqual({ status: "not_ready", provider: "x" })
  })

  it("keeps a verdict whose provider Pi omitted", () => {
    expect(classifyPiAuthProbe({ stdout: '{"status":"ready"}' })).toEqual({
      status: "ready",
      provider: null,
    })
  })
})

describe("parsePiModelProviders", () => {
  // Verbatim `pi --list-models` output, including the trailing column padding.
  const LISTING = [
    "provider     model                                  context  max-out  thinking  images",
    "commandcode  claude-opus-4-8                        1M       65.5K    yes       yes   ",
    "commandcode  claude-haiku-4-5-20251001              200K     65.5K    no        yes   ",
    "deepseek     deepseek-v4-pro                        1M       384K     yes       no    ",
    "",
  ].join("\n")

  it("collects the distinct providers", () => {
    expect(parsePiModelProviders(LISTING)).toEqual({
      status: "ok",
      providers: ["commandcode", "deepseek"],
    })
  })

  it("separates 'no rows' from 'cannot read'", () => {
    // A header with no rows is a real answer: Pi has no usable model, which is
    // exactly the diagnosis the card exists to show before the first prompt.
    expect(parsePiModelProviders("provider  model  context  max-out  thinking  images\n")).toEqual({
      status: "ok",
      providers: [],
    })
    // No header at all means the command failed or its output shape moved. It
    // must never render as "no providers configured".
    expect(parsePiModelProviders("")).toEqual({ status: "unreadable" })
    expect(parsePiModelProviders("pi: command not found")).toEqual({ status: "unreadable" })
  })

  it("survives an added or renamed trailing column", () => {
    const widened = [
      "provider  model     context  max-out  thinking  images  price",
      "deepseek  deepseek-v4-pro  1M  384K  yes  no  0.1",
    ].join("\n")
    expect(parsePiModelProviders(widened)).toEqual({ status: "ok", providers: ["deepseek"] })
  })
})

describe("parsePiModelListing", () => {
  const LISTING = [
    "provider     model                                  context  max-out  thinking  images",
    "commandcode  claude-opus-4-8                        1M       65.5K    yes       yes   ",
    "deepseek     deepseek-v4-pro                        1M       384K     yes       no    ",
    "",
  ].join("\n")

  it("reads every column by header name", () => {
    expect(parsePiModelListing(LISTING)).toEqual({
      status: "ok",
      models: [
        {
          provider: "commandcode",
          id: "claude-opus-4-8",
          context: "1M",
          maxOut: "65.5K",
          thinking: true,
          images: true,
        },
        {
          provider: "deepseek",
          id: "deepseek-v4-pro",
          context: "1M",
          maxOut: "384K",
          thinking: true,
          images: false,
        },
      ],
    })
  })

  it("keeps provider and model when the optional columns move or vanish", () => {
    expect(parsePiModelListing("provider  model\ndeepseek  deepseek-v4-pro\n")).toEqual({
      status: "ok",
      models: [{ provider: "deepseek", id: "deepseek-v4-pro" }],
    })
    expect(parsePiModelListing("")).toEqual({ status: "unreadable" })
  })
})

describe("reconcilePiAuthVerdict", () => {
  it("promotes an extension provider that the listing offers", () => {
    expect(
      reconcilePiAuthVerdict(
        { status: "not_ready", provider: "commandcode", reason: "provider_not_found" },
        ["commandcode", "deepseek"]
      )
    ).toEqual({ status: "ready", provider: "commandcode", evidence: "model_listing" })
  })

  it("leaves Pi's own answers alone", () => {
    const notConfigured = {
      status: "not_ready" as const,
      provider: "anthropic",
      reason: "credentials_not_configured" as const,
    }
    expect(reconcilePiAuthVerdict(notConfigured, ["anthropic"])).toBe(notConfigured)
    const unlisted = {
      status: "not_ready" as const,
      provider: "ghost",
      reason: "provider_not_found" as const,
    }
    expect(reconcilePiAuthVerdict(unlisted, ["deepseek"])).toBe(unlisted)
  })
})
