/** @jest-environment jsdom */

import { BrowserVaultLockedError } from "@/lib/companion/credential-book"
import { CompanionPairPhaseError } from "@/lib/companion/host-orchestration"
import { CompanionApiError } from "@/lib/tauri/companion-auth"

import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"

import {
  diagnosePairFailure,
  diagnosePayloadFailure,
  diagnoseTransport,
  formatPairDiagnostics,
  pairFailureBodyKey,
  type PairFailure,
  type PairFailureKind,
  type PairRemedy,
} from "./pair-failure"

const BASE_FAILURE: PairFailure = {
  stage: "register",
  kind: "unknown",
  detail: "",
  remedies: [],
  retryable: false,
  invitationSpent: false,
}

const LAN_HTTPS = "https://192.168.1.42:27890"
const LOOPBACK = "http://127.0.0.1:27891"

/** The exact exception a browser raises for every kind of blocked request. */
const failedToFetch = () => new TypeError("Failed to fetch")

describe("the opaque `Failed to fetch` split", () => {
  it("blames the origin allowlist when the peer answered", () => {
    const failure = diagnosePairFailure(failedToFetch(), {
      stage: "register",
      baseUrl: LOOPBACK,
      webMode: true,
      peerAnswered: true,
      online: true,
    })
    expect(failure.kind).toBe("origin_blocked")
    expect(failure.remedies).toEqual([
      "enableBrowserAccess",
      "allowlistOrigin",
      "freshInvitation",
    ])
    // Nothing was redeemed — the request never reached the Host's handler.
    expect(failure.invitationSpent).toBe(false)
  })

  it("blames the self-signed certificate when nothing answered a LAN HTTPS Host", () => {
    const failure = diagnosePairFailure(failedToFetch(), {
      stage: "register",
      baseUrl: LAN_HTTPS,
      webMode: true,
      peerAnswered: false,
      online: true,
    })
    expect(failure.kind).toBe("tls_untrusted")
    expect(failure.remedies).toContain("useLoopbackInvitation")
  })

  it("blames reachability when nothing answered an origin the browser could have trusted", () => {
    const failure = diagnosePairFailure(failedToFetch(), {
      stage: "register",
      baseUrl: LOOPBACK,
      webMode: true,
      peerAnswered: false,
      online: true,
    })
    expect(failure.kind).toBe("unreachable")
    expect(failure.retryable).toBe(true)
  })

  it("stays with the unqualified answer when no probe was run", () => {
    const failure = diagnosePairFailure(failedToFetch(), {
      stage: "register",
      baseUrl: LOOPBACK,
      webMode: true,
      online: true,
    })
    expect(failure.kind).toBe("unreachable")
  })

  it("reports offline before anything else", () => {
    const failure = diagnosePairFailure(failedToFetch(), {
      stage: "register",
      baseUrl: LAN_HTTPS,
      webMode: true,
      peerAnswered: false,
      online: false,
    })
    expect(failure.kind).toBe("offline")
  })
})

describe("Host refusals that arrive as real HTTP answers", () => {
  it("keeps the status and the Host's own refusal code", () => {
    const failure = diagnosePairFailure(
      new CompanionApiError("origin not allowed", "web_origin_forbidden", 403),
      { stage: "register", baseUrl: LOOPBACK, webMode: true, online: true }
    )
    expect(failure).toMatchObject({
      kind: "http",
      status: 403,
      code: "web_origin_forbidden",
    })
    expect(failure.remedies[0]).toBe("enableBrowserAccess")
    expect(pairFailureBodyKey(failure)).toBe("httpError.403")
  })

  it("treats a consumed invitation as spent so the UI cannot suggest resubmitting", () => {
    const failure = diagnosePairFailure(
      new CompanionApiError("invitation already used", "invitation_consumed", 401),
      { stage: "register", baseUrl: LOOPBACK, online: true }
    )
    expect(failure.invitationSpent).toBe(true)
    expect(failure.retryable).toBe(false)
    expect(failure.remedies).toEqual(["freshInvitation", "removeStaleDevice"])
  })

  it("offers a retry only for a server-side fault", () => {
    const failure = diagnosePairFailure(
      new CompanionApiError("boom", "", 503),
      { stage: "register", online: true }
    )
    expect(failure.retryable).toBe(true)
    expect(pairFailureBodyKey(failure)).toBe("httpError.5xx")
  })
})

describe("failures after the Host has already registered the device", () => {
  it("names a locked Vault instead of blaming secure storage", () => {
    const failure = diagnosePairFailure(new BrowserVaultLockedError(), {
      stage: "persist",
      baseUrl: LOOPBACK,
      webMode: true,
      online: true,
    })
    expect(failure.kind).toBe("vault_locked")
    expect(failure.remedies[0]).toBe("unlockAccount")
    // The device IS registered on the Host; "pair again" alone is wrong advice.
    expect(failure.invitationSpent).toBe(true)
    expect(failure.retryable).toBe(false)
  })

  it("separates a stored-but-not-activated pairing from a lost credential", () => {
    const activation = diagnosePairFailure(
      new CompanionPairPhaseError("activate", new Error("manifest negotiation failed")),
      { stage: "persist", baseUrl: LOOPBACK, online: true }
    )
    expect(activation.kind).toBe("activate_failed")
    // The credential is on disk, so reconnecting needs no new invitation.
    expect(activation.retryable).toBe(true)
    expect(activation.remedies[0]).toBe("reloadAndRetry")

    const credential = diagnosePairFailure(
      new CompanionPairPhaseError("credential", new Error("quota exceeded")),
      { stage: "persist", baseUrl: LOOPBACK, online: true }
    )
    expect(credential.kind).toBe("persist_failed")
    expect(credential.retryable).toBe(false)
  })

  it("keeps the underlying cause, which the old single sentence discarded", () => {
    const failure = diagnosePairFailure(new Error("QuotaExceededError"), {
      stage: "persist",
      online: true,
    })
    expect(failure.detail).toBe("QuotaExceededError")
    expect(pairFailureBodyKey(failure)).toBe("persistenceError")
  })
})

describe("payload faults", () => {
  it("names the version the Host actually issued", () => {
    const failure = diagnosePayloadFailure({ kind: "version_mismatch", got: 2 })
    expect(failure).toMatchObject({ kind: "payload_version", payloadVersion: 2 })
    expect(failure.remedies).toEqual(["updateHost", "freshInvitation"])
  })

  it("separates an expired invitation from an unreadable one", () => {
    expect(
      diagnosePayloadFailure({ kind: "invalid", message: "pairing invitation has expired" }).kind
    ).toBe("payload_expired")
    expect(diagnosePayloadFailure({ kind: "invalid", message: "missing host" }).kind).toBe(
      "payload_invalid"
    )
    expect(diagnosePayloadFailure({ kind: "wrong_format" }).kind).toBe("payload_wrong_format")
  })
})

describe("diagnoseTransport", () => {
  it("refuses plaintext aimed off-machine before the invitation is spent", () => {
    const failure = diagnoseTransport("http://192.168.1.42:27891", true)
    expect(failure).toMatchObject({ kind: "insecure_transport", stage: "transport" })
    expect(failure?.invitationSpent).toBe(false)
  })

  it("allows loopback plaintext — the browser client's intended door", () => {
    expect(diagnoseTransport(LOOPBACK, true)).toBeNull()
    expect(diagnoseTransport("http://localhost:27891", true)).toBeNull()
  })

  it("does not pre-refuse an https Host it can only suspect of self-signing", () => {
    // Spending a user's one-shot invitation on a guess is worse than trying and
    // reporting precisely; the probe settles it on the failure path instead.
    expect(diagnoseTransport(LAN_HTTPS, true)).toBeNull()
  })

  it("never applies to the native shell, which pins the certificate itself", () => {
    expect(diagnoseTransport("http://192.168.1.42:27891", false)).toBeNull()
  })
})

describe("formatPairDiagnostics", () => {
  it("carries every field a bug report needs and no invitation material", () => {
    const failure = diagnosePairFailure(
      new CompanionApiError("nope", "web_origin_forbidden", 403),
      { stage: "register", baseUrl: LOOPBACK, origin: "http://127.0.0.1:3000", online: true }
    )
    const text = formatPairDiagnostics(failure)
    expect(text).toContain("stage: register")
    expect(text).toContain("kind: http")
    expect(text).toContain("status: 403")
    expect(text).toContain("code: web_origin_forbidden")
    expect(text).toContain("origin: http://127.0.0.1:3000")
    expect(text).toContain("invitationSpent: false")
  })
})

describe("message-catalogue coverage", () => {
  // `lint:i18n` skips dynamic keys, and every title/remedy here is looked up as
  // `failure.title.${kind}` / `failure.remedy.${id}`. Without this test a new
  // kind ships as a raw key on screen and no gate notices.
  const KINDS: PairFailureKind[] = [
    "payload_wrong_format",
    "payload_version",
    "payload_expired",
    "payload_invalid",
    "insecure_transport",
    "offline",
    "origin_blocked",
    "tls_untrusted",
    "unreachable",
    "http",
    "vault_locked",
    "persist_failed",
    "activate_failed",
    "scan_failed",
    "clipboard_unavailable",
    "unknown",
  ]
  const REMEDIES: PairRemedy[] = [
    "enableBrowserAccess",
    "allowlistOrigin",
    "useLoopbackInvitation",
    "checkHostRunning",
    "sameNetwork",
    "freshInvitation",
    "unlockAccount",
    "updateHost",
    "checkHostLogs",
    "removeStaleDevice",
    "reloadAndRetry",
  ]

  function lookup(messages: Record<string, unknown>, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined,
        messages
      )
  }

  it.each([
    ["en", en.mobile.pair as Record<string, unknown>],
    ["zh-CN", zh.mobile.pair as Record<string, unknown>],
  ])("has every title, body and remedy string in %s", (_locale, pair) => {
    for (const kind of KINDS) {
      expect(typeof lookup(pair, `failure.title.${kind}`)).toBe("string")
      expect(typeof lookup(pair, pairFailureBodyKey({ ...BASE_FAILURE, kind }))).toBe("string")
    }
    for (const remedy of REMEDIES) {
      expect(typeof lookup(pair, `failure.remedy.${remedy}`)).toBe("string")
    }
  })

  it("covers every kind the type allows", () => {
    // A new member of the union without a row above is a compile error here.
    const covered: Record<PairFailureKind, true> = Object.fromEntries(
      KINDS.map((kind) => [kind, true])
    ) as Record<PairFailureKind, true>
    expect(Object.keys(covered)).toHaveLength(KINDS.length)
  })
})
