import {
  nextSshHostId,
  sshHostToConnectRequest,
  validateSshHostProfile,
  type SshHostProfile,
} from "./ssh-profiles"

function host(overrides: Partial<SshHostProfile> = {}): SshHostProfile {
  return {
    id: "ssh-1",
    name: "Production",
    host: "prod.example.com",
    port: 22,
    username: "deploy",
    authMethod: "password",
    credentialRef: "ssh-1",
    ...overrides,
  }
}

describe("SSH host profiles", () => {
  it("builds a secret-free connection request from a valid profile", () => {
    expect(sshHostToConnectRequest(host(), 36, 120, "project-1")).toEqual({
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      authMethod: "password",
      credentialRef: "ssh-1",
      privateKeyPath: undefined,
      rows: 36,
      cols: 120,
      projectId: "project-1",
      profileId: "ssh-1",
      displayName: "Production",
    })
  })

  it("rejects invalid hosts, ports, usernames, and incomplete key profiles", () => {
    expect(validateSshHostProfile(host({ name: " " }))).toBe("name")
    expect(validateSshHostProfile(host({ host: " " }))).toBe("host")
    expect(validateSshHostProfile(host({ host: "bad host" }))).toBe("host")
    expect(validateSshHostProfile(host({ port: 0 }))).toBe("port")
    expect(validateSshHostProfile(host({ port: 22.5 }))).toBe("port")
    expect(validateSshHostProfile(host({ port: 65_536 }))).toBe("port")
    expect(validateSshHostProfile(host({ username: "" }))).toBe("username")
    expect(validateSshHostProfile(host({ username: "bad user" }))).toBe("username")
    expect(
      validateSshHostProfile(
        host({ authMethod: "privateKey", privateKeyPath: "", credentialRef: undefined })
      )
    ).toBe("privateKeyPath")
  })

  it("accepts an agent profile that carries neither a key path nor a credential", () => {
    const agent = host({
      authMethod: "agent",
      privateKeyPath: undefined,
      credentialRef: undefined,
    })
    expect(validateSshHostProfile(agent)).toBeNull()
    expect(sshHostToConnectRequest(agent, 24, 80)).toEqual(
      expect.objectContaining({
        authMethod: "agent",
        credentialRef: undefined,
        privateKeyPath: undefined,
      })
    )
  })

  it("allows an unencrypted private key without storing a credential", () => {
    expect(
      validateSshHostProfile(
        host({
          authMethod: "privateKey",
          privateKeyPath: "~/.ssh/id_ed25519",
          credentialRef: undefined,
        })
      )
    ).toBeNull()
  })

  it("generates a stable unused id", () => {
    expect(nextSshHostId([host({ id: "ssh-2" }), host({ id: "ssh-3" })])).toBe("ssh-4")
    expect(nextSshHostId(undefined)).toBe("ssh-1")
    expect(nextSshHostId([host({ id: "ssh-2" }), host({ id: "ssh-4" })])).toBe("ssh-3")
  })

  it("normalizes input dimensions and optional private key paths", () => {
    expect(
      sshHostToConnectRequest(
        host({
          name: " Production ",
          host: "prod.example.com",
          username: "deploy",
          authMethod: "privateKey",
          privateKeyPath: " ~/.ssh/id_ed25519 ",
        }),
        0,
        3.9
      )
    ).toEqual(
      expect.objectContaining({
        displayName: "Production",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        rows: 1,
        cols: 3,
      })
    )
    expect(sshHostToConnectRequest(host({ name: "" }), 24, 80)).toBeNull()
  })
})
