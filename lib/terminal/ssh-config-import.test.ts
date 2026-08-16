import {
  applySshConfigImport,
  parseSshConfig,
  planSshConfigImport,
  readSshConfigFile,
  type SshImportResolution,
} from "./ssh-config-import"
import type { SshHostProfile } from "./ssh-profiles"

function plan(text: string, existing: readonly SshHostProfile[] = []) {
  return planSshConfigImport(parseSshConfig(text), existing)
}

function apply(
  text: string,
  existing: readonly SshHostProfile[] = [],
  resolutions: Record<string, SshImportResolution> = {}
) {
  return applySshConfigImport(existing, plan(text, existing), resolutions)
}

describe("parseSshConfig", () => {
  it("reads the directives this app can hold", () => {
    const { entries } = parseSshConfig(`
Host prod
  HostName server.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
`)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      aliases: ["prod"],
      hostName: "server.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "~/.ssh/id_ed25519",
    })
  })

  it("accepts the key=value spelling and strips quotes and comments", () => {
    const { entries } = parseSshConfig(`
# a comment
Host prod
  HostName=server.example.com
  User="deploy user"
`)
    expect(entries[0].hostName).toBe("server.example.com")
    expect(entries[0].user).toBe("deploy user")
  })

  it("keeps the first IdentityFile because this app holds exactly one", () => {
    const { entries } = parseSshConfig(`
Host prod
  IdentityFile ~/.ssh/first
  IdentityFile ~/.ssh/second
`)
    expect(entries[0].identityFile).toBe("~/.ssh/first")
  })

  it("parses both forward directions, with and without a bind address", () => {
    const { entries } = parseSshConfig(`
Host prod
  LocalForward 8080 db.internal:5432
  LocalForward 0.0.0.0:9090 cache:6379
  RemoteForward 9000 localhost:3000
`)
    expect(entries[0].localForwards).toEqual([
      { listenPort: 8080, destinationHost: "db.internal", destinationPort: 5432 },
      {
        bindAddress: "0.0.0.0",
        listenPort: 9090,
        destinationHost: "cache",
        destinationPort: 6379,
      },
    ])
    expect(entries[0].remoteForwards).toEqual([
      { listenPort: 9000, destinationHost: "localhost", destinationPort: 3000 },
    ])
  })

  it("understands bracketed IPv6 in a forward", () => {
    const { entries } = parseSshConfig(`
Host prod
  LocalForward [::1]:8080 [fd00::1]:5432
`)
    expect(entries[0].localForwards[0]).toEqual({
      bindAddress: "::1",
      listenPort: 8080,
      destinationHost: "fd00::1",
      destinationPort: 5432,
    })
  })

  it("reports a malformed forward instead of importing half of it", () => {
    const { entries, notices } = parseSshConfig(`
Host prod
  LocalForward 8080
`)
    expect(entries[0].localForwards).toEqual([])
    expect(notices).toContainEqual({ kind: "malformedForward", line: 3, subject: "8080" })
  })

  it("names a wildcard host rather than dropping it", () => {
    // `Host *` is where most people keep their real defaults, so importing the
    // file and saying nothing would be actively misleading.
    const { entries, notices } = parseSshConfig(`
Host *
  User deploy
`)
    expect(entries).toEqual([])
    expect(notices).toContainEqual({ kind: "wildcardHost", line: 2, subject: "*" })
  })

  it("keeps the literal aliases of a mixed Host line and names the patterns", () => {
    const { entries, notices } = parseSshConfig(`
Host prod prod-* !staging
  HostName server.example.com
`)
    expect(entries[0].aliases).toEqual(["prod"])
    expect(
      notices.filter((notice) => notice.kind === "wildcardHost").map((n) => n.subject)
    ).toEqual(["prod-*", "!staging"])
  })

  it("skips a Match block whole rather than attributing it to the previous host", () => {
    const { entries, notices } = parseSshConfig(`
Host prod
  HostName server.example.com
Match host bastion
  User root
  Port 2222
`)
    expect(entries).toHaveLength(1)
    // `User root` belongs to the Match, not to `prod`.
    expect(entries[0].user).toBeUndefined()
    expect(entries[0].port).toBeUndefined()
    expect(notices).toContainEqual({ kind: "matchBlock", line: 4, subject: "host bastion" })
  })

  it("reports Include rather than following it", () => {
    const { notices } = parseSshConfig("Include ~/.ssh/config.d/*\n")
    expect(notices).toContainEqual({ kind: "include", line: 1, subject: "~/.ssh/config.d/*" })
  })

  it("reports ProxyCommand, which has no equivalent here", () => {
    const { notices } = parseSshConfig(`
Host prod
  ProxyCommand ssh gateway -W %h:%p
`)
    expect(notices).toContainEqual({ kind: "proxyCommand", line: 3, subject: "prod" })
  })

  it("notes an alias with no HostName without refusing it", () => {
    const { entries, notices } = parseSshConfig("Host prod\n  User deploy\n")
    expect(entries).toHaveLength(1)
    expect(notices).toContainEqual({ kind: "missingHostName", line: 1, subject: "prod" })
  })

  it("stays quiet about directives that are simply irrelevant here", () => {
    // This app's own TOFU store answers the host-key question; echoing
    // `StrictHostKeyChecking` back would bury the notices that matter.
    const { notices } = parseSshConfig(`
Host prod
  HostName server.example.com
  StrictHostKeyChecking yes
  Compression yes
  ForwardAgent yes
`)
    expect(notices).toEqual([])
  })

  it("names a directive it does not model", () => {
    const { notices } = parseSshConfig(`
Host prod
  HostName server.example.com
  CertificateFile ~/.ssh/id_ed25519-cert.pub
`)
    expect(notices).toContainEqual({
      kind: "unsupportedDirective",
      line: 4,
      subject: "certificatefile",
    })
  })
})

describe("planSshConfigImport", () => {
  it("defaults a fresh alias to create and a matching one to overwrite", () => {
    const existing: SshHostProfile[] = [
      { id: "ssh-1", name: "prod", host: "old", port: 22, username: "old", authMethod: "password" },
    ]
    const { entries } = plan("Host prod\n  HostName new.example\nHost staging\n", existing)
    expect(entries[0]).toMatchObject({
      name: "prod",
      existingId: "ssh-1",
      defaultResolution: "overwrite",
    })
    expect(entries[1]).toMatchObject({ name: "staging", defaultResolution: "create" })
    expect(entries[1].existingId).toBeUndefined()
  })

  it("connects to the alias itself when the block gives no HostName", () => {
    const { entries } = plan("Host build-box\n  User ci\n")
    expect(entries[0]).toMatchObject({ name: "build-box", host: "build-box", username: "ci" })
  })

  it("imports a remote forward switched off and says so", () => {
    const { entries } = plan("Host prod\n  RemoteForward 9000 localhost:3000\n")
    expect(entries[0].remoteForwards[0].enabled).toBe(false)
    expect(entries[0].adjustments).toContain("remoteForwardDisabled")
  })

  it("narrows a wider bind address and reports the narrowing", () => {
    // Importing `0.0.0.0` as loopback without a word would quietly change what
    // the user's own config said the rule does.
    const { entries } = plan("Host prod\n  LocalForward 0.0.0.0:9090 cache:6379\n")
    expect(entries[0].localForwards[0]).toMatchObject({ localPort: 9090, enabled: true })
    expect(entries[0].adjustments).toContain("bindNarrowedToLoopback")
  })

  it("reports that only the first alias of a block survives", () => {
    const { entries } = plan("Host prod production\n  HostName server.example\n")
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe("prod")
    expect(entries[0].adjustments).toContain("extraAliasesDropped")
  })

  it("links ProxyJump to an alias defined later in the file", () => {
    const { entries } = plan(`
Host prod
  HostName server.example
  ProxyJump bastion
Host bastion
  HostName jump.example
`)
    const prod = entries.find((entry) => entry.name === "prod")
    const bastion = entries.find((entry) => entry.name === "bastion")
    expect(prod?.jumpKey).toBe(bastion?.key)
    expect(bastion?.synthesized).toBe(false)
  })

  it("synthesizes a bastion for a ProxyJump with no Host block of its own", () => {
    const { entries } = plan(`
Host prod
  HostName server.example
  ProxyJump ci@jump.example:2222
`)
    const bastion = entries.find((entry) => entry.synthesized)
    expect(bastion).toMatchObject({
      name: "jump.example",
      host: "jump.example",
      username: "ci",
      port: 2222,
    })
    expect(entries.find((entry) => entry.name === "prod")?.jumpKey).toBe(bastion?.key)
  })

  it("chains a comma-separated ProxyJump outermost-first", () => {
    const { entries } = plan(`
Host prod
  HostName server.example
  ProxyJump outer.example,inner.example
`)
    const outer = entries.find((entry) => entry.name === "outer.example")
    const inner = entries.find((entry) => entry.name === "inner.example")
    const prod = entries.find((entry) => entry.name === "prod")
    // `a,b` means: reach b through a, then the target through b.
    expect(outer?.jumpKey).toBeUndefined()
    expect(inner?.jumpKey).toBe(outer?.key)
    expect(prod?.jumpKey).toBe(inner?.key)
  })

  it("defaults a synthesized bastion that already exists to skip", () => {
    // The user has already configured that machine here; a hop invented from
    // a ProxyJump line should not overwrite their work.
    const existing: SshHostProfile[] = [
      {
        id: "ssh-9",
        name: "jump.example",
        host: "jump.example",
        port: 22,
        username: "ci",
        authMethod: "agent",
      },
    ]
    const { entries } = plan("Host prod\n  ProxyJump jump.example\n", existing)
    const bastion = entries.find((entry) => entry.synthesized)
    expect(bastion).toMatchObject({ existingId: "ssh-9", defaultResolution: "skip" })
  })
})

describe("applySshConfigImport", () => {
  it("adds new profiles without disturbing unrelated ones", () => {
    const existing: SshHostProfile[] = [
      { id: "ssh-1", name: "other", host: "o", port: 22, username: "u", authMethod: "agent" },
    ]
    const result = apply("Host prod\n  HostName server.example\n  User deploy\n", existing)
    expect(result.created).toBe(1)
    expect(result.replaced).toBe(0)
    expect(result.profiles).toHaveLength(2)
    expect(result.profiles.find((p) => p.name === "other")).toEqual(existing[0])
    expect(result.profiles.find((p) => p.name === "prod")).toMatchObject({
      host: "server.example",
      username: "deploy",
      authMethod: "password",
      jumpHostId: null,
    })
  })

  it("picks key auth when the config named a key, password otherwise", () => {
    const withKey = apply("Host prod\n  IdentityFile ~/.ssh/id_ed25519\n")
    expect(withKey.profiles[0]).toMatchObject({
      authMethod: "privateKey",
      privateKeyPath: "~/.ssh/id_ed25519",
    })
    const withoutKey = apply("Host prod\n  HostName s.example\n")
    expect(withoutKey.profiles[0].authMethod).toBe("password")
    expect(withoutKey.profiles[0].privateKeyPath).toBeUndefined()
  })

  it("keeps the keyring reference when replacing a saved profile", () => {
    // `~/.ssh/config` has never held a secret, so an import must not orphan the
    // one already in the keyring under this profile's id.
    const existing: SshHostProfile[] = [
      {
        id: "ssh-1",
        name: "prod",
        host: "old.example",
        port: 22,
        username: "old",
        authMethod: "password",
        credentialRef: "ssh-1",
      },
    ]
    const result = apply("Host prod\n  HostName new.example\n  User deploy\n", existing)
    expect(result.replaced).toBe(1)
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]).toMatchObject({
      id: "ssh-1",
      host: "new.example",
      username: "deploy",
      credentialRef: "ssh-1",
    })
  })

  it("leaves a skipped entry exactly as it was", () => {
    const existing: SshHostProfile[] = [
      { id: "ssh-1", name: "prod", host: "old", port: 22, username: "old", authMethod: "agent" },
    ]
    const importPlan = plan("Host prod\n  HostName new.example\n", existing)
    const result = applySshConfigImport(existing, importPlan, {
      [importPlan.entries[0].key]: "skip",
    })
    expect(result).toMatchObject({ created: 0, replaced: 0 })
    expect(result.profiles).toEqual(existing)
  })

  it("wires a jump chain to real ids", () => {
    const result = apply(`
Host prod
  HostName server.example
  ProxyJump bastion
Host bastion
  HostName jump.example
`)
    const bastion = result.profiles.find((profile) => profile.name === "bastion")
    const prod = result.profiles.find((profile) => profile.name === "prod")
    expect(bastion).toBeDefined()
    expect(prod?.jumpHostId).toBe(bastion?.id)
    expect(bastion?.jumpHostId).toBeNull()
  })

  it("points a jump at the existing profile a skipped entry already matched", () => {
    const existing: SshHostProfile[] = [
      {
        id: "ssh-9",
        name: "bastion",
        host: "jump.example",
        port: 22,
        username: "ci",
        authMethod: "agent",
      },
    ]
    const importPlan = plan(
      "Host prod\n  HostName server.example\n  ProxyJump bastion\nHost bastion\n",
      existing
    )
    const bastionKey = importPlan.entries.find((entry) => entry.name === "bastion")!.key
    const result = applySshConfigImport(existing, importPlan, { [bastionKey]: "skip" })
    // Declining to change the bastion is not declining to route through it.
    expect(result.profiles.find((p) => p.name === "prod")?.jumpHostId).toBe("ssh-9")
    expect(result.droppedJumps).toEqual([])
  })

  it("reports a jump that could not be imported instead of silently going direct", () => {
    const importPlan = plan("Host prod\n  HostName server.example\n  ProxyJump jump.example\n")
    const bastionKey = importPlan.entries.find((entry) => entry.synthesized)!.key
    const result = applySshConfigImport([], importPlan, { [bastionKey]: "skip" })
    // Connecting direct reaches a different machine than the config described,
    // so the caller has to be able to say so.
    expect(result.profiles.find((p) => p.name === "prod")?.jumpHostId).toBeNull()
    expect(result.droppedJumps).toEqual(["prod"])
  })

  it("mints ids that do not collide with saved profiles", () => {
    const existing: SshHostProfile[] = [
      { id: "ssh-1", name: "a", host: "a", port: 22, username: "u", authMethod: "agent" },
    ]
    const result = apply("Host b\nHost c\n", existing)
    const ids = result.profiles.map((profile) => profile.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("ssh-1")
  })
})

describe("readSshConfigFile", () => {
  it("reads the file under the resolved home directory", async () => {
    const readTextFile = jest.fn(async () => "Host prod\n")
    const source = await readSshConfigFile({
      home: async () => "/Users/dev",
      exists: async () => true,
      readTextFile,
    })
    expect(source).toEqual({ kind: "found", path: "/Users/dev/.ssh/config", text: "Host prod\n" })
    expect(readTextFile).toHaveBeenCalledWith("/Users/dev/.ssh/config")
  })

  it("treats a missing file as absent rather than an error", async () => {
    // A machine that has never used ssh has no config, which is ordinary.
    await expect(
      readSshConfigFile({
        home: async () => "/Users/dev/",
        exists: async () => false,
        readTextFile: async () => "",
      })
    ).resolves.toEqual({ kind: "absent", path: "/Users/dev/.ssh/config" })
  })

  it("reports absent when the home directory cannot be resolved", async () => {
    await expect(
      readSshConfigFile({
        home: async () => null,
        exists: async () => true,
        readTextFile: async () => "",
      })
    ).resolves.toEqual({ kind: "absent", path: null })
  })

  it("lets an unreadable file surface as an error the user can act on", async () => {
    await expect(
      readSshConfigFile({
        home: async () => "/Users/dev",
        exists: async () => true,
        readTextFile: async () => {
          throw new Error("permission denied")
        },
      })
    ).rejects.toThrow("permission denied")
  })
})
