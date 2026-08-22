import {
  capabilityFingerprint,
  effectiveCapabilities,
  effectiveCapabilitiesForRow,
  hasEffectiveCapability,
  suppressionFor,
} from "./effective-capabilities"
import { getPlatformCapabilities } from "./platform-capabilities"
import { CAPABILITY_SUPPRESSION_REASONS } from "@/types/connectors/effective-capability"
import { ALL_CAPABILITIES } from "@/types/connectors/capability"
import { ALL_PLATFORM_KINDS } from "@/types/connectors/platform-kind"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const slackScopes = (...scopes: string[]) => ({
  connectedScopes: { scopes, grantedAtMs: 1 },
})

describe("effectiveCapabilities", () => {
  describe("absent evidence never suppresses", () => {
    it("keeps the whole declared set when nothing is known about the instance", () => {
      const snapshot = effectiveCapabilities({ platform: "telegram" })
      expect(snapshot.capabilities).toEqual(getPlatformCapabilities("telegram"))
      expect(snapshot.suppressed).toEqual([])
    })

    it("keeps Slack scoped capabilities for a hand-pasted token with no recorded grant", () => {
      // A bot token configured without OAuth records no `connectedScopes`. It
      // may well hold every scope; refusing to guess is the point.
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: { assistantAppEnabled: true },
      })
      expect(hasEffectiveCapability(snapshot, "send.file")).toBe(true)
      expect(hasEffectiveCapability(snapshot, "history.fetch")).toBe(true)
    })

    it("treats an empty recorded scope list as no evidence rather than no permission", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: { connectedScopes: { scopes: [], grantedAtMs: 1 }, assistantAppEnabled: true },
      })
      expect(snapshot.suppressed).toEqual([])
    })

    it("keeps OneBot upstream-gated capabilities when the probe never ran", () => {
      const snapshot = effectiveCapabilities({ platform: "onebot" })
      expect(hasEffectiveCapability(snapshot, "send.reaction")).toBe(true)
      expect(hasEffectiveCapability(snapshot, "send.file")).toBe(true)
    })
  })

  describe("recorded OAuth scopes", () => {
    it("drops file sends when the grant lacks files:write", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: slackScopes("chat:write", "channels:history"),
      })
      expect(hasEffectiveCapability(snapshot, "send.file")).toBe(false)
      expect(hasEffectiveCapability(snapshot, "send.image")).toBe(false)
      expect(suppressionFor(snapshot, "send.file")).toEqual({
        capability: "send.file",
        reason: "missing_oauth_scope",
        detail: "files:write",
      })
    })

    it("accepts any one of the history scopes", () => {
      for (const scope of ["channels:history", "groups:history", "im:history", "mpim:history"]) {
        const snapshot = effectiveCapabilities({
          platform: "slack",
          settings: slackScopes("chat:write", scope),
        })
        expect(hasEffectiveCapability(snapshot, "history.fetch")).toBe(true)
      }
    })

    it("drops history when no history scope was granted", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: slackScopes("chat:write"),
      })
      expect(hasEffectiveCapability(snapshot, "history.fetch")).toBe(false)
      expect(suppressionFor(snapshot, "history.fetch")?.detail).toBe(
        "channels:history | groups:history | im:history | mpim:history"
      )
    })

    it("drops every chat:write capability together when the grant lacks it", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: slackScopes("channels:history"),
      })
      for (const capability of ["send.text", "edit", "delete", "send.reply"] as const) {
        expect(hasEffectiveCapability(snapshot, capability)).toBe(false)
      }
    })

    it("leaves presence.status alone — its bot-token scope is unverified", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: slackScopes("chat:write"),
      })
      expect(hasEffectiveCapability(snapshot, "presence.status")).toBe(true)
    })

    it("does not project Lark's send-as user grant onto bot capabilities", () => {
      // Lark bot permissions are granted in the console, not in this token.
      const snapshot = effectiveCapabilities({
        platform: "lark",
        settings: slackScopes("im:message:send_as_bot"),
      })
      expect(snapshot.suppressed).toEqual([])
    })
  })

  describe("probed upstream implementation (OneBot)", () => {
    it("drops reactions on an upstream without set_msg_emoji_like", () => {
      const snapshot = effectiveCapabilities({
        platform: "onebot",
        implMetadata: { impl: "lagrange", version: "0.1", features: ["upload_group_file"] },
      })
      expect(hasEffectiveCapability(snapshot, "send.reaction")).toBe(false)
      expect(hasEffectiveCapability(snapshot, "send.file")).toBe(true)
      expect(suppressionFor(snapshot, "send.reaction")).toEqual({
        capability: "send.reaction",
        reason: "upstream_impl_unsupported",
        detail: "set_msg_emoji_like",
      })
    })

    it("drops file upload on an upstream without upload_group_file", () => {
      const snapshot = effectiveCapabilities({
        platform: "onebot",
        implMetadata: { impl: "llonebot", version: "1", features: ["set_msg_emoji_like"] },
      })
      expect(hasEffectiveCapability(snapshot, "send.file")).toBe(false)
      expect(hasEffectiveCapability(snapshot, "send.reaction")).toBe(true)
    })

    it("keeps both on NapCat", () => {
      const snapshot = effectiveCapabilities({
        platform: "onebot",
        implMetadata: {
          impl: "napcat",
          version: "4",
          features: ["markdown-card", "upload_group_file", "set_msg_emoji_like"],
        },
      })
      expect(snapshot.suppressed).toEqual([])
    })

    it("does not apply the OneBot feature table to another platform", () => {
      const snapshot = effectiveCapabilities({
        platform: "discord",
        implMetadata: { impl: "napcat", version: "4", features: [] },
      })
      expect(hasEffectiveCapability(snapshot, "send.reaction")).toBe(true)
    })
  })

  describe("instance settings", () => {
    it("drops Slack typing when the assistant app is off", () => {
      const snapshot = effectiveCapabilities({ platform: "slack", scopeKind: "thread" })
      expect(hasEffectiveCapability(snapshot, "typing")).toBe(false)
      expect(suppressionFor(snapshot, "typing")).toEqual({
        capability: "typing",
        reason: "instance_setting_off",
        detail: "assistantAppEnabled",
      })
    })

    it("keeps Slack typing in a thread when the assistant app is on", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: { assistantAppEnabled: true },
        scopeKind: "thread",
      })
      expect(hasEffectiveCapability(snapshot, "typing")).toBe(true)
    })
  })

  describe("conversation scene", () => {
    it("drops QQ reactions outside the guild channel scene", () => {
      const snapshot = effectiveCapabilities({ platform: "qq-official", scopeKind: "private" })
      expect(hasEffectiveCapability(snapshot, "send.reaction")).toBe(false)
      expect(suppressionFor(snapshot, "send.reaction")?.reason).toBe("scene_unsupported")
    })

    it("drops QQ typing outside C2C", () => {
      const snapshot = effectiveCapabilities({ platform: "qq-official", scopeKind: "channel" })
      expect(hasEffectiveCapability(snapshot, "typing")).toBe(false)
      expect(hasEffectiveCapability(snapshot, "send.reaction")).toBe(true)
    })

    it("keeps both when no scene is supplied — the instance can do them somewhere", () => {
      const snapshot = effectiveCapabilities({ platform: "qq-official" })
      expect(hasEffectiveCapability(snapshot, "send.reaction")).toBe(true)
      expect(hasEffectiveCapability(snapshot, "typing")).toBe(true)
    })

    it("drops Slack typing outside a thread even with the assistant app on", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: { assistantAppEnabled: true },
        scopeKind: "channel",
      })
      expect(suppressionFor(snapshot, "typing")?.reason).toBe("scene_unsupported")
    })
  })

  describe("suppression bookkeeping", () => {
    it("records a capability at most once and keeps the two lists complementary", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        // Lacks chat:write AND the assistant app: typing and every chat:write
        // capability are unavailable, but each for exactly one reason.
        settings: slackScopes("channels:history"),
        scopeKind: "channel",
      })
      const seen = snapshot.suppressed.map((entry) => entry.capability)
      expect(new Set(seen).size).toBe(seen.length)
      expect(snapshot.capabilities).toEqual(
        snapshot.declared.filter((capability) => !seen.includes(capability))
      )
    })

    it("prefers the scope reason over the setting reason for the same capability", () => {
      // Slack `typing` needs no scope, so this pins the ORDER rather than the
      // outcome: a capability failing two rules reports the first declared one.
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: { ...slackScopes("channels:history"), assistantAppEnabled: false },
      })
      expect(suppressionFor(snapshot, "send.text")?.reason).toBe("missing_oauth_scope")
      expect(suppressionFor(snapshot, "typing")?.reason).toBe("instance_setting_off")
    })

    it("returns undefined for a capability the platform never declared", () => {
      const snapshot = effectiveCapabilities({ platform: "wecom" })
      expect(suppressionFor(snapshot, "history.fetch")).toBeUndefined()
      expect(hasEffectiveCapability(snapshot, "history.fetch")).toBe(false)
    })

    it("projects an explicitly supplied declared set (plugin connectors)", () => {
      const snapshot = effectiveCapabilities({
        platform: "telegram",
        declared: ["send.text", "send.file"],
      })
      expect(snapshot.declared).toEqual(["send.text", "send.file"])
      expect(snapshot.capabilities).toEqual(["send.text", "send.file"])
    })
  })

  describe("runtime matrix", () => {
    it("turns off Slack streaming features when the assistant app is off", () => {
      const snapshot = effectiveCapabilities({ platform: "slack" })
      expect(snapshot.runtime.textStreaming).toBe(false)
      expect(snapshot.runtime.componentMutation).toBe(false)
      expect(snapshot.runtime.suggestedPrompts).toBe(false)
    })

    it("turns them on when it is enabled", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        settings: { assistantAppEnabled: true },
      })
      expect(snapshot.runtime.textStreaming).toBe(true)
    })

    it("prefers a live adapter's own matrix over re-deriving one", () => {
      const snapshot = effectiveCapabilities({
        platform: "slack",
        runtime: {
          ...effectiveCapabilities({ platform: "slack" }).runtime,
          textStreaming: true,
        },
      })
      expect(snapshot.runtime.textStreaming).toBe(true)
    })

    it("applies the Lark scope refinement through the shared resolver", () => {
      expect(
        effectiveCapabilities({ platform: "lark", scopeKind: "private" }).runtime.followUpBubbles
      ).toBe(true)
      expect(
        effectiveCapabilities({ platform: "lark", scopeKind: "group" }).runtime.followUpBubbles
      ).toBe(false)
    })
  })

  describe("effectiveCapabilitiesForRow", () => {
    const row = {
      id: "slack-1",
      type: "slack",
      settings: slackScopes("chat:write"),
      implMetadata: undefined,
    } as unknown as AdapterInstanceRow

    it("carries the adapter id onto the snapshot", () => {
      const snapshot = effectiveCapabilitiesForRow(row)
      expect(snapshot.adapterId).toBe("slack-1")
      expect(hasEffectiveCapability(snapshot, "history.fetch")).toBe(false)
    })

    it("passes the scene through", () => {
      const snapshot = effectiveCapabilitiesForRow(row, { scopeKind: "channel" })
      expect(snapshot.scopeKind).toBe("channel")
    })
  })

  describe("rule tables stay anchored to the catalogues", () => {
    // Every rule keys off a capability id and a platform kind. A rename in
    // either catalogue would otherwise leave a rule that silently never fires
    // — the failure mode is a capability that is never suppressed again.
    const rulePlatforms = ["slack", "onebot", "qq-official", "lark"] as const

    it("only names real platforms", () => {
      for (const platform of rulePlatforms) {
        expect(ALL_PLATFORM_KINDS).toContain(platform)
      }
    })

    it("only names real capabilities", () => {
      // Project every rule platform with no evidence at all except the one
      // piece each rule needs, and assert what came back is catalogued.
      for (const platform of rulePlatforms) {
        for (const capability of effectiveCapabilities({ platform }).declared) {
          expect(ALL_CAPABILITIES).toContain(capability)
        }
      }
    })

    it("emits only catalogued suppression reasons", () => {
      const reasons = new Set<string>()
      for (const snapshot of [
        effectiveCapabilities({ platform: "slack", settings: slackScopes("app_mentions:read") }),
        effectiveCapabilities({
          platform: "onebot",
          implMetadata: { impl: "lagrange", version: "0", features: [] },
        }),
        effectiveCapabilities({ platform: "qq-official", scopeKind: "group" }),
      ]) {
        for (const entry of snapshot.suppressed) reasons.add(entry.reason)
      }
      // All four reasons are reachable from these three projections.
      expect(reasons.size).toBe(CAPABILITY_SUPPRESSION_REASONS.length)
      for (const reason of reasons) {
        expect(CAPABILITY_SUPPRESSION_REASONS).toContain(reason)
      }
    })
  })

  describe("capabilityFingerprint", () => {
    it("changes when the granted scopes change", () => {
      const a = capabilityFingerprint({ platform: "slack", settings: slackScopes("chat:write") })
      const b = capabilityFingerprint({
        platform: "slack",
        settings: slackScopes("chat:write", "files:write"),
      })
      expect(a).not.toBe(b)
    })

    it("changes when the upstream probe result changes", () => {
      const a = capabilityFingerprint({
        platform: "onebot",
        implMetadata: { impl: "napcat", version: "1", features: ["set_msg_emoji_like"] },
      })
      const b = capabilityFingerprint({
        platform: "onebot",
        implMetadata: { impl: "lagrange", version: "1", features: [] },
      })
      expect(a).not.toBe(b)
    })

    it("changes when the scene or the assistant-app setting changes", () => {
      const base = capabilityFingerprint({ platform: "slack" })
      expect(capabilityFingerprint({ platform: "slack", scopeKind: "thread" })).not.toBe(base)
      expect(
        capabilityFingerprint({ platform: "slack", settings: { assistantAppEnabled: true } })
      ).not.toBe(base)
    })

    it("is stable for the same inputs", () => {
      const input = { platform: "slack" as const, settings: slackScopes("chat:write") }
      expect(capabilityFingerprint(input)).toBe(capabilityFingerprint(input))
    })
  })
})
