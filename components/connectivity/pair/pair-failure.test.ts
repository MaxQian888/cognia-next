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
  fingerprintMismatchFailure,
  normalizeFingerprint,
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
const LOOPBACK_HTTPS = "https://127.0.0.1:27890"

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
    expect(failure.remedies).toEqual(["enableBrowserAccess", "allowlistOrigin", "freshInvitation"])
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

  it("blames the certificate on a LOOPBACK HTTPS Host too", () => {
    // The reported case: `cognia-server` listens on https://127.0.0.1:27890
    // with an rcgen self-signed certificate (tls.rs) and no CA, so a browser
    // cannot complete the handshake. This used to classify as `unreachable`,
    // whose advice is to confirm the Host is listening on that address — while
    // it was listening on exactly that address.
    const failure = diagnosePairFailure(failedToFetch(), {
      stage: "register",
      baseUrl: LOOPBACK_HTTPS,
      webMode: true,
      peerAnswered: false,
      online: true,
    })
    expect(failure.kind).toBe("tls_untrusted")
    expect(failure.remedies).toContain("useLoopbackInvitation")
    expect(failure.invitationSpent).toBe(false)
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

  it("sends a re-submitted invitation to a fresh one, not to the allow-list", () => {
    // The live regression: a `cgnp3` pasted twice comes back as a bare 403, and
    // the one-bucket mapping answered "turn on browser access" — for a listener
    // the request had just travelled through to earn the refusal.
    const failure = diagnosePairFailure(
      new CompanionApiError(
        "the owner invitation is expired or already used",
        "invalid_owner_invitation",
        403
      ),
      { stage: "register", baseUrl: LOOPBACK, webMode: true, online: true }
    )
    expect(failure.remedies).toEqual(["freshInvitation", "removeStaleDevice"])
    expect(failure.remedies).not.toContain("enableBrowserAccess")
    expect(failure.invitationSpent).toBe(true)
    expect(pairFailureBodyKey(failure)).toBe("httpError.403Spent")
  })

  it.each([
    "owner_invitation_required",
    "worker_enrollment_required",
    "browser_enrollment_required",
  ])("treats %s the same way — the invitation, not the origin", (code) => {
    const failure = diagnosePairFailure(
      new CompanionApiError("a one-time invitation is required", code, 403),
      { stage: "register", baseUrl: LOOPBACK, online: true }
    )
    expect(failure.remedies[0]).toBe("freshInvitation")
    expect(failure.invitationSpent).toBe(true)
  })

  it("does not offer a fresh invitation when the account itself is refused", () => {
    // A new invitation from the same account reproduces this byte for byte.
    const failure = diagnosePairFailure(
      new CompanionApiError("binding mismatch", "host_binding_mismatch", 403),
      { stage: "register", baseUrl: LOOPBACK, online: true }
    )
    expect(failure.remedies).toEqual(["removeStaleDevice", "checkHostLogs"])
    expect(failure.invitationSpent).toBe(false)
    expect(pairFailureBodyKey(failure)).toBe("httpError.403Identity")
  })

  it("keeps the ambiguous ordering for a 403 with no code", () => {
    const failure = diagnosePairFailure(new CompanionApiError("nope", "", 403), {
      stage: "register",
      baseUrl: LOOPBACK,
      online: true,
    })
    expect(failure.remedies[0]).toBe("enableBrowserAccess")
    expect(pairFailureBodyKey(failure)).toBe("httpError.403")
  })

  it("offers a retry only for a server-side fault", () => {
    const failure = diagnosePairFailure(new CompanionApiError("boom", "", 503), {
      stage: "register",
      online: true,
    })
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

describe("the technical detail keeps the cause", () => {
  it("unpacks an AggregateError instead of showing only its summary", () => {
    // The live regression: activation wrapped the real 403 and the rollback
    // failure in an AggregateError, and the panel rendered nothing but the
    // wrapper's own sentence — so the two errors that said what went wrong
    // never reached the screen.
    const aggregate = new AggregateError(
      [new Error("sync_pull refused: 403"), new Error("previous target could not be restored")],
      "Companion Host activation failed and rollback was incomplete."
    )
    const failure = diagnosePairFailure(new CompanionPairPhaseError("activate", aggregate), {
      stage: "activate",
      baseUrl: LOOPBACK,
      webMode: true,
      online: true,
    })
    expect(failure.kind).toBe("activate_failed")
    expect(failure.detail).toContain("Companion Host activation failed")
    expect(failure.detail).toContain("sync_pull refused: 403")
    expect(failure.detail).toContain("previous target could not be restored")
  })

  it("follows a `cause` chain down to the error that started it", () => {
    const root = new Error("connect ECONNREFUSED 127.0.0.1:27891")
    const middle = new Error("host_feature_manifest failed", { cause: root })
    const failure = diagnosePairFailure(new CompanionPairPhaseError("activate", middle), {
      stage: "activate",
      online: true,
    })
    expect(failure.detail).toContain("host_feature_manifest failed")
    expect(failure.detail).toContain("ECONNREFUSED")
  })

  it("does not append the literal text `undefined` when there is no cause", () => {
    const failure = diagnosePairFailure(new Error("plain failure"), {
      stage: "activate",
      online: true,
    })
    expect(failure.detail).toBe("plain failure")
  })

  it("terminates on a self-referential cause", () => {
    const looping = new Error("loops back on itself")
    ;(looping as { cause?: unknown }).cause = looping
    const failure = diagnosePairFailure(looping, { stage: "activate", online: true })
    expect(failure.detail).toBe("loops back on itself")
  })

  it("says an identical activation and rollback failure once, not twice", () => {
    // The live shape: `restartWebHostBindings` failed the same way on the way
    // in and on the way back, and `CompanionPairPhaseError` copies its reason's
    // message as well as keeping it as `cause` — three prints of one sentence.
    const same = "The selected Web Host credential is unavailable."
    const failure = diagnosePairFailure(
      new CompanionPairPhaseError(
        "activate",
        new AggregateError(
          [new Error(same), new Error(same)],
          "Companion Host activation failed and rollback was incomplete."
        )
      ),
      { stage: "activate", online: true }
    )
    expect(failure.detail.match(/rollback was incomplete/g)).toHaveLength(1)
    expect(failure.detail.match(/credential is unavailable/g)).toHaveLength(1)
    expect(failure.detail).not.toContain("[1]")
  })

  it("still numbers two genuinely different legs", () => {
    const failure = diagnosePairFailure(
      new AggregateError([new Error("activation: 403"), new Error("rollback: no target")], "both"),
      { stage: "activate", online: true }
    )
    expect(failure.detail).toContain("[1] activation: 403")
    expect(failure.detail).toContain("[2] rollback: no target")
  })

  it("caps a wide AggregateError instead of filling the panel", () => {
    const aggregate = new AggregateError(
      Array.from({ length: 9 }, (_, index) => new Error(`leg ${index}`)),
      "many legs failed"
    )
    const failure = diagnosePairFailure(aggregate, { stage: "activate", online: true })
    expect(failure.detail).toContain("leg 0")
    expect(failure.detail).toContain("leg 3")
    expect(failure.detail).not.toContain("leg 4")
    expect(failure.detail).toContain("(+5 more)")
  })

  it("carries the unpacked causes into the copy-paste diagnostics block", () => {
    const failure = diagnosePairFailure(
      new CompanionPairPhaseError(
        "activate",
        new AggregateError([new Error("the real cause")], "the useless summary")
      ),
      { stage: "activate", online: true }
    )
    expect(formatPairDiagnostics(failure)).toContain("the real cause")
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
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
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
    // The 403 body key is chosen by refusal code, so the `kind` loop above
    // only ever reaches the generic one.
    for (const key of ["httpError.403Spent", "httpError.403Identity"]) {
      expect(typeof lookup(pair, key)).toBe("string")
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

describe("fingerprint pinning", () => {
  it("compares fingerprints as bytes, ignoring colons and case", () => {
    expect(normalizeFingerprint("AB:CD:EF")).toBe("abcdef")
    expect(normalizeFingerprint("abcdef")).toBe(normalizeFingerprint("AB:CD:EF"))
    expect(normalizeFingerprint("ab cd")).toBe("abcd")
  })

  /**
   * Built only after the Host redeemed the invitation, so the invitation is
   * gone and a retry cannot help. The client must say so and must not persist.
   */
  it("builds a spent, non-retryable failure carrying both fingerprints", () => {
    const failure = fingerprintMismatchFailure({
      baseUrl: "https://host:27890",
      expectedFingerprint: "aa:bb",
      reportedFingerprint: "cc:dd",
    })
    expect(failure.kind).toBe("fingerprint_mismatch")
    expect(failure.stage).toBe("register")
    expect(failure.retryable).toBe(false)
    expect(failure.invitationSpent).toBe(true)
    expect(failure.expectedFingerprint).toBe("aa:bb")
    expect(failure.reportedFingerprint).toBe("cc:dd")
    expect(failure.remedies[0]).toBe("freshInvitation")
    expect(pairFailureBodyKey(failure)).toBe("fingerprintMismatch")
  })
})
