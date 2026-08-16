import {
  buildForwardedConnectRequest,
  formatLocalForward,
  formatRemoteForward,
  jumpHostCandidates,
  MAX_JUMP_DEPTH,
  newLocalForward,
  newRemoteForward,
  resolveJumpChain,
  validateLocalForward,
  validateRemoteForward,
} from "./ssh-forwarding"
import type { LocalForward, RemoteForward, SshHostProfile } from "./ssh-profiles"

function host(id: string, overrides: Partial<SshHostProfile> = {}): SshHostProfile {
  return {
    id,
    name: id,
    host: `${id}.example`,
    port: 22,
    username: "deploy",
    authMethod: "agent",
    ...overrides,
  }
}

function local(overrides: Partial<LocalForward> = {}): LocalForward {
  return {
    id: "lfwd-1",
    localPort: 8080,
    remoteHost: "db.internal",
    remotePort: 5432,
    enabled: true,
    ...overrides,
  }
}

function remote(overrides: Partial<RemoteForward> = {}): RemoteForward {
  return {
    id: "rfwd-1",
    remotePort: 9000,
    localHost: "localhost",
    localPort: 3000,
    enabled: true,
    ...overrides,
  }
}

describe("forward validation", () => {
  it("accepts a well-formed rule in either direction", () => {
    expect(validateLocalForward(local())).toBeNull()
    expect(validateRemoteForward(remote())).toBeNull()
  })

  it("rejects ports outside the 16-bit range on both ends", () => {
    expect(validateLocalForward(local({ localPort: 0 }))).toBe("port_out_of_range")
    expect(validateLocalForward(local({ localPort: 65_536 }))).toBe("port_out_of_range")
    expect(validateLocalForward(local({ remotePort: 0 }))).toBe("port_out_of_range")
    // A port typed into a number input arrives as a float often enough to be
    // worth refusing rather than truncating behind the user's back.
    expect(validateLocalForward(local({ localPort: 80.5 }))).toBe("port_out_of_range")
    expect(validateRemoteForward(remote({ remotePort: 0 }))).toBe("port_out_of_range")
    expect(validateRemoteForward(remote({ localPort: 70_000 }))).toBe("port_out_of_range")
  })

  it("distinguishes a missing destination from a malformed one", () => {
    expect(validateLocalForward(local({ remoteHost: "   " }))).toBe("host_empty")
    expect(validateLocalForward(local({ remoteHost: "db internal" }))).toBe("host_invalid")
    expect(validateRemoteForward(remote({ localHost: "" }))).toBe("host_empty")
    expect(validateRemoteForward(remote({ localHost: "local host" }))).toBe("host_invalid")
  })

  it("refuses two rules claiming one port, in both directions", () => {
    expect(validateLocalForward(local(), [8080])).toBe("duplicate_local_port")
    expect(validateLocalForward(local(), [9090])).toBeNull()
    // The original module checked this for `-L` only, so two `-R` rules could
    // silently fight over one port on the server.
    expect(validateRemoteForward(remote(), [9000])).toBe("duplicate_remote_port")
    expect(validateRemoteForward(remote(), [9001])).toBeNull()
  })
})

describe("forward formatting", () => {
  it("names the loopback bind so the UI cannot imply a wider one", () => {
    expect(formatLocalForward(local())).toBe("127.0.0.1:8080 → db.internal:5432")
    expect(formatRemoteForward(remote())).toBe("remote 127.0.0.1:9000 → localhost:3000")
  })
})

describe("resolveJumpChain", () => {
  it("returns the target alone when nothing is in front of it", () => {
    const target = host("target")
    expect(resolveJumpChain(target, [target])?.map((hop) => hop.id)).toEqual(["target"])
  })

  it("orders hops outermost first with the target last", () => {
    const outer = host("outer")
    const inner = host("inner", { jumpHostId: "outer" })
    const target = host("target", { jumpHostId: "inner" })
    expect(resolveJumpChain(target, [outer, inner, target])?.map((hop) => hop.id)).toEqual([
      "outer",
      "inner",
      "target",
    ])
  })

  it("refuses a chain that points at a profile that is gone", () => {
    const target = host("target", { jumpHostId: "deleted" })
    // Connecting direct would reach a machine the user did not ask for, so a
    // broken chain has to fail rather than degrade.
    expect(resolveJumpChain(target, [target])).toBeNull()
  })

  it("refuses a cycle rather than walking it forever", () => {
    const a = host("a", { jumpHostId: "b" })
    const b = host("b", { jumpHostId: "a" })
    expect(resolveJumpChain(a, [a, b])).toBeNull()

    const self = host("self", { jumpHostId: "self" })
    expect(resolveJumpChain(self, [self])).toBeNull()
  })

  it("refuses a chain deeper than the native limit", () => {
    const profiles = Array.from({ length: MAX_JUMP_DEPTH + 2 }, (_, index) =>
      host(`h${index}`, { jumpHostId: index === 0 ? null : `h${index - 1}` })
    )
    const deepest = profiles[profiles.length - 1]
    expect(resolveJumpChain(deepest, profiles)).toBeNull()
    expect(resolveJumpChain(profiles[MAX_JUMP_DEPTH], profiles)).not.toBeNull()
  })
})

describe("jumpHostCandidates", () => {
  it("never offers the profile itself", () => {
    const a = host("a")
    const b = host("b")
    expect(jumpHostCandidates(a, [a, b]).map((profile) => profile.id)).toEqual(["b"])
  })

  it("hides a profile that already routes through this one", () => {
    const bastion = host("bastion")
    // `edge` goes through `bastion`, so `bastion` cannot also go through `edge`.
    const edge = host("edge", { jumpHostId: "bastion" })
    expect(jumpHostCandidates(bastion, [bastion, edge]).map((p) => p.id)).toEqual([])
    expect(jumpHostCandidates(edge, [bastion, edge]).map((p) => p.id)).toEqual(["bastion"])
  })

  it("hides a profile whose own chain is already broken", () => {
    const target = host("target")
    const broken = host("broken", { jumpHostId: "missing" })
    expect(jumpHostCandidates(target, [target, broken])).toEqual([])
  })
})

describe("new rule defaults", () => {
  it("starts a local forward enabled and a remote forward off", () => {
    // `-L` listens only on this machine; `-R` opens a socket on someone
    // else's and points it back here, so it waits to be turned on.
    expect(newLocalForward([]).enabled).toBe(true)
    expect(newRemoteForward([]).enabled).toBe(false)
  })

  it("mints ids that do not collide with existing rules", () => {
    const existing = [local({ id: "lfwd-1" }), local({ id: "lfwd-2" })]
    expect(newLocalForward(existing).id).toBe("lfwd-3")
    expect(newRemoteForward([remote({ id: "rfwd-1" })]).id).toBe("rfwd-2")
  })
})

describe("buildForwardedConnectRequest", () => {
  const base = { rows: 24, cols: 80, projectId: "project-1" }

  it("carries the resolved hops, excluding the target itself", () => {
    const outer = host("outer", { username: "jump", port: 2222 })
    const target = host("target", { jumpHostId: "outer" })
    const built = buildForwardedConnectRequest({
      profile: target,
      allProfiles: [outer, target],
      ...base,
    })
    expect(built.kind).toBe("ok")
    if (built.kind !== "ok") return
    expect(built.request.jumpChain).toEqual([
      {
        host: "outer.example",
        port: 2222,
        username: "jump",
        authMethod: "agent",
        credentialRef: undefined,
        privateKeyPath: undefined,
      },
    ])
    expect(built.request.host).toBe("target.example")
  })

  it("drops disabled rules instead of shipping them with a flag", () => {
    const profile = host("target", {
      localForwards: [local({ id: "on" }), local({ id: "off", localPort: 9090, enabled: false })],
      remoteForwards: [remote({ id: "roff", enabled: false })],
    })
    const built = buildForwardedConnectRequest({ profile, allProfiles: [profile], ...base })
    expect(built.kind).toBe("ok")
    if (built.kind !== "ok") return
    // A rule the user switched off must not reach the native side at all —
    // there is then nothing for a default to revive.
    expect(built.request.localForwards?.map((rule) => rule.id)).toEqual(["on"])
    expect(built.request.remoteForwards).toEqual([])
  })

  it("reports which part of the profile is wrong, not just that it is", () => {
    const profile = host("target", { host: "bad host" })
    const built = buildForwardedConnectRequest({ profile, allProfiles: [profile], ...base })
    expect(built).toEqual({ kind: "invalid", reason: "host" })
  })

  it("refuses a broken jump chain", () => {
    const profile = host("target", { jumpHostId: "missing" })
    expect(buildForwardedConnectRequest({ profile, allProfiles: [profile], ...base })).toEqual({
      kind: "invalid",
      reason: "jumpChain",
    })
  })

  it("refuses a bastion that could not authenticate on its own account", () => {
    // A jump host is a server we log into, not a transparent relay, so an
    // incomplete one is as fatal as an incomplete target.
    const bastion = host("bastion", { authMethod: "privateKey", privateKeyPath: "  " })
    const profile = host("target", { jumpHostId: "bastion" })
    expect(
      buildForwardedConnectRequest({ profile, allProfiles: [bastion, profile], ...base })
    ).toEqual({ kind: "invalid", reason: "jumpChain" })
  })

  it("refuses two enabled rules that would fight over one port", () => {
    const profile = host("target", {
      localForwards: [local({ id: "a" }), local({ id: "b" })],
    })
    expect(buildForwardedConnectRequest({ profile, allProfiles: [profile], ...base })).toEqual({
      kind: "invalid",
      reason: "localForward",
    })

    const remoteClash = host("target", {
      remoteForwards: [remote({ id: "a" }), remote({ id: "b" })],
    })
    expect(
      buildForwardedConnectRequest({ profile: remoteClash, allProfiles: [remoteClash], ...base })
    ).toEqual({ kind: "invalid", reason: "remoteForward" })
  })

  it("ignores a clash between rules that are not both on", () => {
    const profile = host("target", {
      localForwards: [local({ id: "a" }), local({ id: "b", enabled: false })],
    })
    expect(buildForwardedConnectRequest({ profile, allProfiles: [profile], ...base }).kind).toBe(
      "ok"
    )
  })
})
