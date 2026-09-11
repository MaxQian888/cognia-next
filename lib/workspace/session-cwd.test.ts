import type { ChatSession } from "@cognia/agent-config-types"
import { resolveSessionCwd, type SessionCwdDeps } from "./session-cwd"

function deps(overrides: Partial<SessionCwdDeps> = {}): SessionCwdDeps {
  return {
    getSession: async () => undefined,
    getProject: async () => undefined,
    getCharacterWorkingDir: async () => undefined,
    getDefaultWorkingDir: async () => "/home/default",
    ...overrides,
  }
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return { id: "ses_1", title: "t", createdAt: 0, updatedAt: 0, ...overrides } as ChatSession
}

describe("resolveSessionCwd", () => {
  it("resolves nothing for an unknown session, never the app default", async () => {
    await expect(resolveSessionCwd("ghost", deps())).resolves.toBeUndefined()
  })

  it("prefers the session's own working directory", async () => {
    const d = deps({
      getSession: async () => session({ workingDir: "/repo/override", projectId: "p1" }),
      getProject: async () => ({ roots: [{ path: "/repo/project", isPrimary: true }] }) as never,
    })
    await expect(resolveSessionCwd("ses_1", d)).resolves.toBe("/repo/override")
  })

  it("falls through execution binding, workspace root, character, then app default", async () => {
    const withBinding = deps({
      getSession: async () =>
        session({
          projectId: "p1",
          executionContext: {
            projectRoot: "/leased/alias",
            workspaceBinding: { kind: "local" },
          } as never,
        }),
      getProject: async () => ({ roots: [{ path: "/repo/project", isPrimary: true }] }) as never,
    })
    await expect(resolveSessionCwd("ses_1", withBinding)).resolves.toBe("/leased/alias")

    const withProject = deps({
      getSession: async () => session({ projectId: "p1", characterId: "c1" }),
      getProject: async () => ({ roots: [{ path: "/repo/project", isPrimary: true }] }) as never,
      getCharacterWorkingDir: async () => "/character",
    })
    await expect(resolveSessionCwd("ses_1", withProject)).resolves.toBe("/repo/project")

    const withCharacter = deps({
      getSession: async () => session({ characterId: "c1" }),
      getCharacterWorkingDir: async () => "/character",
    })
    await expect(resolveSessionCwd("ses_1", withCharacter)).resolves.toBe("/character")

    await expect(
      resolveSessionCwd("ses_1", deps({ getSession: async () => session() }))
    ).resolves.toBe("/home/default")
  })

  it("does not borrow a workspace the session never named", async () => {
    const d = deps({
      getSession: async () => session(),
      getProject: async () => ({ roots: [{ path: "/repo/open", isPrimary: true }] }) as never,
      getDefaultWorkingDir: async () => undefined,
    })
    await expect(resolveSessionCwd("ses_1", d)).resolves.toBeUndefined()
  })

  it("treats a failing read as absent and keeps resolving down the chain", async () => {
    const d = deps({
      getSession: async () => session({ projectId: "p1", characterId: "c1" }),
      getProject: async () => {
        throw new Error("dexie closed")
      },
      getCharacterWorkingDir: async () => {
        throw new Error("no character")
      },
    })
    await expect(resolveSessionCwd("ses_1", d)).resolves.toBe("/home/default")
    await expect(
      resolveSessionCwd(
        "ses_1",
        deps({
          getSession: async () => {
            throw new Error("boom")
          },
        })
      )
    ).resolves.toBeUndefined()
  })
})
