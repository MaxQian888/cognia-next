/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { resolveBotInstallationCwd } from "./resolve-cwd"

const NOW = 1_700_000_000_000

async function seedDefinition(character?: string) {
  const definition = {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "agent-turn",
    prompt: "summarise",
    triggers: [{ id: "manual", kind: "manual" }],
    ...(character ? { character } : {}),
  } as PluginBotDef
  registerBot("digest", { id: "acme:digest", definition }, { pluginId: "acme" })
}

async function seedInstallation(scope: Parameters<typeof installBot>[0]["scope"]) {
  return installBot({
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope,
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  const db = getDb()
  await db.botInstallations.clear()
  await db.projects.clear()
  await db.characters.clear()
  await db.settings.clear()
}, 15_000)

describe("resolveBotInstallationCwd", () => {
  it("returns undefined for an installation that is gone", async () => {
    expect(await resolveBotInstallationCwd("boti_missing")).toBeUndefined()
  })

  it("resolves the primary root of the workspace the installation is scoped to", async () => {
    await seedDefinition()
    await getDb().projects.add({
      id: "proj_1",
      name: "Web",
      roots: [{ path: "/repos/web", isPrimary: true }],
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    await seedInstallation({ kind: "workspace", workspaceId: "proj_1" })

    expect(await resolveBotInstallationCwd("boti_1")).toBe("/repos/web")
  })

  it("prefers the project scope over the workspace it is denormalized from", async () => {
    await seedDefinition()
    const db = getDb()
    await db.projects.bulkAdd([
      {
        id: "ws_1",
        name: "Workspace",
        roots: [{ path: "/repos/workspace", isPrimary: true }],
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "proj_1",
        name: "Project",
        roots: [{ path: "/repos/project", isPrimary: true }],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ] as never)
    await seedInstallation({ kind: "project", workspaceId: "ws_1", projectId: "proj_1" })

    expect(await resolveBotInstallationCwd("boti_1")).toBe("/repos/project")
  })

  it("falls back to the persona's own directory when the scope has no root", async () => {
    await seedDefinition("char_1")
    await getDb().characters.add({
      id: "char_1",
      name: "Digest",
      workingDir: "/home/persona",
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    await seedInstallation({ kind: "account" })

    expect(await resolveBotInstallationCwd("boti_1")).toBe("/home/persona")
  })

  it("falls back to the app default, so an account-scoped Bot still runs", async () => {
    await seedDefinition()
    await seedInstallation({ kind: "account" })
    await getDb().settings.put({ id: "singleton", defaultWorkingDir: "/home/me" } as never)

    expect(await resolveBotInstallationCwd("boti_1")).toBe("/home/me")
  })

  it("returns undefined when nothing in the chain answers", async () => {
    await seedDefinition()
    await seedInstallation({ kind: "account" })

    expect(await resolveBotInstallationCwd("boti_1")).toBeUndefined()
  })
})
