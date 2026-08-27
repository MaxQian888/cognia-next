import { adapterPolicyMirrorPatch, parseAdapterPolicyRelay } from "./adapter-policy-relay"

const sectionsOf = (payload: Record<string, unknown>) =>
  Object.fromEntries(
    parseAdapterPolicyRelay({ id: "a1", ...payload }).sections.map((entry) => [
      entry.section,
      entry.patch,
    ])
  )

describe("parseAdapterPolicyRelay", () => {
  it("refuses a payload with no adapter to apply it to", () => {
    expect(() => parseAdapterPolicyRelay({})).toThrow(/id is required/)
    expect(() => parseAdapterPolicyRelay({ id: "" })).toThrow(/id is required/)
  })

  it("names no section when the payload only carries the id", () => {
    // An empty patch would still write an `adapter.config_changed` audit row
    // claiming a section changed.
    expect(parseAdapterPolicyRelay({ id: "a1" })).toEqual({ id: "a1", sections: [] })
  })

  it("groups each field under the section whose desktop card owns it", () => {
    const sections = sectionsOf({
      defaultMode: "manual",
      defaultAutonomy: "confirm",
      a2uiEnabled: false,
      muted: true,
      quietHours: { from: "22:00", to: "07:00", tz: "UTC" },
      hostCapabilityCeiling: ["ocr"],
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    })

    expect(sections.behavior).toEqual({
      defaultMode: "manual",
      defaultAutonomy: "confirm",
      a2uiEnabled: false,
    })
    expect(sections.delivery).toEqual({
      muted: true,
      quietHours: { from: "22:00", to: "07:00", tz: "UTC" },
    })
    expect(sections.permissions).toEqual({ hostCapabilityCeiling: ["ocr"] })
    expect(sections.trigger).toEqual({
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    })
  })

  describe("absent means leave it, null means unpin it", () => {
    it("omits a field the payload never mentioned", () => {
      const sections = sectionsOf({ muted: true })
      expect(sections.behavior).toBeUndefined()
      expect(sections.delivery).toEqual({ muted: true })
    })

    it("carries an explicit clear as `undefined`, which is what Dexie removes", () => {
      const { behavior } = sectionsOf({ defaultAutonomy: null, defaultEngagement: null })
      // `toEqual` treats an undefined value and a missing key alike, so the
      // key set is asserted separately — that difference is the whole point.
      expect(Object.keys(behavior).sort()).toEqual(["defaultAutonomy", "defaultEngagement"])
      expect(behavior.defaultAutonomy).toBeUndefined()
      expect(behavior.defaultEngagement).toBeUndefined()
    })

    it("clears the quiet-hours window on an explicit null", () => {
      const { delivery } = sectionsOf({ quietHours: null })
      expect(Object.keys(delivery)).toEqual(["quietHours"])
      expect(delivery.quietHours).toBeUndefined()
    })

    it("keeps an empty capability ceiling distinct from a cleared one", () => {
      // `[]` clamps every host capability off; `null` removes the clamp.
      expect(sectionsOf({ hostCapabilityCeiling: [] }).permissions.hostCapabilityCeiling).toEqual(
        []
      )
      expect(
        sectionsOf({ hostCapabilityCeiling: null }).permissions.hostCapabilityCeiling
      ).toBeUndefined()
    })
  })

  describe("axis values", () => {
    it.each([
      ["defaultAutonomy", "autopilot"],
      ["defaultEngagement", "background"],
      ["defaultAuthority", "bypassPermissions"],
      ["inboundActivationPolicy", "mention_activates"],
      ["activeRunDispatchMode", "steer"],
    ])("accepts %s = %s", (key, value) => {
      expect(sectionsOf({ [key]: value }).behavior).toEqual({ [key]: value })
    })

    it.each([
      ["defaultMode", "yolo"],
      ["defaultAutonomy", "supervise"],
      ["defaultEngagement", "inline-ish"],
      ["defaultAuthority", "root"],
      ["inboundActivationPolicy", "mention"],
      ["activeRunDispatchMode", "interrupt"],
    ])("refuses %s = %s rather than dropping it", (key, value) => {
      expect(() => parseAdapterPolicyRelay({ id: "a1", [key]: value })).toThrow(
        new RegExp(`adapter_update_policy\\.${key}`)
      )
    })

    it("refuses to clear the legacy mode mirror — every row carries one", () => {
      expect(() => parseAdapterPolicyRelay({ id: "a1", defaultMode: null })).toThrow(
        /defaultMode must be/
      )
    })

    it("refuses a non-positive or fractional activation TTL", () => {
      expect(sectionsOf({ activationTtlMs: 3_600_000 }).behavior.activationTtlMs).toBe(3_600_000)
      for (const bad of [0, -1, 1.5, "3600000"]) {
        expect(() => parseAdapterPolicyRelay({ id: "a1", activationTtlMs: bad })).toThrow(
          /activationTtlMs/
        )
      }
    })
  })

  describe("trigger policy", () => {
    const policy = {
      rules: [
        { kind: "private-default" },
        { kind: "self-mention" },
        { kind: "reply-to-bot" },
        { kind: "slash-command", prefixes: ["/ask"] },
        { kind: "keyword", words: ["deploy"], caseInsensitive: true },
        { kind: "user-allowlist", userIds: ["u1"] },
        { kind: "channel-allowlist", channelIds: ["c1"] },
      ],
      blockers: [
        { kind: "user-blocklist", userIds: ["u2"] },
        { kind: "channel-blocklist", channelIds: ["c2"] },
        { kind: "keyword-blocklist", words: ["secret"] },
        { kind: "rate-limit", perUserPerMin: 3, perChannelPerMin: 10, perTenantPerMin: 60 },
        { kind: "cooldown-after-bot-reply", secs: 30 },
      ],
      storeUnmatchedInDraftMode: true,
    }

    it("round-trips every rule and blocker kind", () => {
      expect(sectionsOf({ trigger: policy }).trigger.trigger).toEqual(policy)
    })

    it("keeps an omitted tenant ceiling omitted", () => {
      // Defaulting it to 0 would be a bot that answers nobody.
      const { trigger } = sectionsOf({
        trigger: {
          rules: [],
          blockers: [{ kind: "rate-limit", perUserPerMin: 3, perChannelPerMin: 10 }],
          storeUnmatchedInDraftMode: false,
        },
      })
      expect(trigger.trigger?.blockers[0]).not.toHaveProperty("perTenantPerMin")
    })

    it.each([
      [{ kind: "nope" }, /trigger\.rules\[0\]\.kind/],
      [{ kind: "slash-command" }, /trigger\.rules\[0\]\.prefixes/],
      [{ kind: "keyword", words: ["x"] }, /trigger\.rules\[0\]\.caseInsensitive/],
      [{ kind: "keyword", words: [1], caseInsensitive: true }, /trigger\.rules\[0\]\.words/],
      [{ kind: "user-allowlist" }, /trigger\.rules\[0\]\.userIds/],
      ["private-default", /trigger\.rules\[0\] must be an object/],
    ])("refuses the malformed rule %p", (rule, message) => {
      expect(() =>
        parseAdapterPolicyRelay({
          id: "a1",
          trigger: { rules: [rule], blockers: [], storeUnmatchedInDraftMode: false },
        })
      ).toThrow(message)
    })

    it.each([
      [{ kind: "rate-limit", perUserPerMin: 3 }, /perChannelPerMin/],
      [{ kind: "rate-limit", perUserPerMin: -1, perChannelPerMin: 1 }, /perUserPerMin/],
      [{ kind: "cooldown-after-bot-reply" }, /secs/],
      [{ kind: "nope" }, /trigger\.blockers\[0\]\.kind/],
    ])("refuses the malformed blocker %p", (blocker, message) => {
      expect(() =>
        parseAdapterPolicyRelay({
          id: "a1",
          trigger: { rules: [], blockers: [blocker], storeUnmatchedInDraftMode: false },
        })
      ).toThrow(message)
    })

    it("refuses a partial policy — the write replaces, it does not merge", () => {
      expect(() => parseAdapterPolicyRelay({ id: "a1", trigger: { rules: [] } })).toThrow(
        /trigger\.blockers/
      )
      expect(() =>
        parseAdapterPolicyRelay({ id: "a1", trigger: { rules: [], blockers: [] } })
      ).toThrow(/storeUnmatchedInDraftMode/)
      expect(() => parseAdapterPolicyRelay({ id: "a1", trigger: null })).toThrow(
        /trigger must be an object/
      )
    })
  })

  it("refuses a malformed quiet-hours window instead of storing half of one", () => {
    for (const bad of [{ from: "22:00", to: "07:00" }, { from: 22, to: 7, tz: "UTC" }, "22:00"]) {
      expect(() => parseAdapterPolicyRelay({ id: "a1", quietHours: bad })).toThrow(/quietHours/)
    }
  })

  it("refuses an unknown host capability", () => {
    expect(() =>
      parseAdapterPolicyRelay({ id: "a1", hostCapabilityCeiling: ["ocr", "root_shell"] })
    ).toThrow(/hostCapabilityCeiling/)
  })
})

describe("adapterPolicyMirrorPatch", () => {
  it("flattens every section into the one patch a client mirror needs", () => {
    expect(
      adapterPolicyMirrorPatch({
        id: "a1",
        defaultMode: "draft",
        muted: true,
        hostCapabilityCeiling: ["ocr", "goal_driving"],
        trigger: {
          rules: [{ kind: "self-mention" }],
          blockers: [],
          storeUnmatchedInDraftMode: true,
        },
      })
    ).toEqual({
      defaultMode: "draft",
      muted: true,
      hostCapabilityCeiling: ["ocr", "goal_driving"],
      trigger: { rules: [{ kind: "self-mention" }], blockers: [], storeUnmatchedInDraftMode: true },
    })
  })

  it("keeps a clear as a present `undefined` key, so Dexie removes it", () => {
    const patch = adapterPolicyMirrorPatch({ id: "a1", defaultAutonomy: null, quietHours: null })
    // `Object.assign` copies a key whose value is undefined; losing it here
    // would leave the mirror pinned to an axis the host just dropped.
    expect(Object.keys(patch).sort()).toEqual(["defaultAutonomy", "quietHours"])
  })

  it("never carries the adapter id into the row's own fields", () => {
    expect(adapterPolicyMirrorPatch({ id: "a1", muted: false })).not.toHaveProperty("id")
  })

  it("throws on the same payloads the host would reject", () => {
    expect(() => adapterPolicyMirrorPatch({ id: "a1", defaultMode: "chaos" })).toThrow()
  })
})
