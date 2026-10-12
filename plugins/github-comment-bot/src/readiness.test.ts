import type { BotInstallationSnapshot } from "@cognia/plugin-sdk"

import { fixture, NOW, REPOSITORY } from "./comment-bot.test-helpers"
import { SetupError } from "./config"
import { readerFor } from "./identity"
import {
  checkReadiness,
  claimTrigger,
  hostWarnings,
  ingressMode,
  TRIGGER_CLAIM_TTL_MS,
  triggerClaimKey,
} from "./readiness"

function snapshot(over: Partial<BotInstallationSnapshot> = {}): BotInstallationSnapshot {
  return {
    id: "install",
    createdAt: NOW - 1000,
    config: {},
    triggerState: {},
    webhookEnabled: false,
    definitionId: "github-comment-bot:comment-commands",
    pinnedVersion: "1.0.0",
    status: "enabled",
    scope: { kind: "account" },
    triggers: [
      { id: "github", kind: "event", armed: false },
      { id: "poll", kind: "poll", armed: true },
    ],
    credentialSlots: [{ id: "github", optional: false, bound: true }],
    readiness: { policyDecisions: true, executionRoute: "gateway" },
    ...over,
  }
}

it("lets one installation per repository and trigger answer on a host", async () => {
  const f = fixture()
  let now = NOW
  await claimTrigger(f.context, { installationId: "a" }, REPOSITORY, "@Bot", () => now)
  await claimTrigger(f.context, { installationId: "a" }, REPOSITORY, "@bot", () => now)
  await expect(
    claimTrigger(f.context, { installationId: "b" }, REPOSITORY, "@bot[bot]", () => now)
  ).rejects.toMatchObject({
    code: "trigger_conflict",
  })
  await expect(
    claimTrigger(f.context, { installationId: "b" }, REPOSITORY, "@other", () => now)
  ).resolves.toBeUndefined()
  // A quiet claim lapses.
  now += TRIGGER_CLAIM_TTL_MS
  await claimTrigger(f.context, { installationId: "b" }, REPOSITORY, "@bot", () => now)
  expect(await f.context.storage.get(triggerClaimKey(REPOSITORY, "@bot"))).toEqual({
    installationId: "b",
    at: now,
  })
  expect(SetupError).toBeDefined()
})

it("names the ingress the installation actually has", () => {
  expect(ingressMode(snapshot())).toBe("polling_only")
  expect(
    ingressMode(
      snapshot({ webhookEnabled: true, triggers: [{ id: "github", kind: "event", armed: true }] })
    )
  ).toBe("webhook_ready")
  // A webhook endpoint without the trigger armed delivers nothing.
  expect(
    ingressMode(
      snapshot({ webhookEnabled: true, triggers: [{ id: "github", kind: "event", armed: false }] })
    )
  ).toBe("no_ingress")
})

it("turns the host's answers into warnings, never into guesses", () => {
  expect(hostWarnings(snapshot(), { publicationMode: "automatic" })).toEqual([])
  expect(
    hostWarnings(snapshot({ readiness: { policyDecisions: false, executionRoute: "native" } }), {
      publicationMode: "automatic",
    }).map((problem) => problem.code)
  ).toEqual(["publication_grant_missing", "pii_boundary_unverified"])
  expect(
    hostWarnings(snapshot({ readiness: { policyDecisions: false } }), {
      publicationMode: "approval",
    }).map((problem) => problem.code)
  ).toEqual(["executor_unavailable"])
  expect(
    hostWarnings(snapshot({ readiness: undefined }), { publicationMode: "automatic" })
  ).toEqual([])
})

it("probes the repository, the account and a real checkout", async () => {
  const f = fixture({ triggerId: "check" })
  const health = jest.fn(async () => ({ health: "healthy", checkedAt: "t" }))
  ;(f.context.integrations as unknown as { checkAccountHealth: typeof health }).checkAccountHealth =
    health
  const reader = readerFor(f.context, f.run, f.config)
  const ready = await checkReadiness(f.context, f.run, f.config, reader, snapshot(), {
    cloneProbe: true,
  })
  expect(ready).toEqual({ ready: true, ingress: "polling_only", problems: [] })
  expect(health).toHaveBeenCalledWith({ runId: "run", slotId: "github" })
  expect(f.mocks.acquire).toHaveBeenCalledWith({
    kind: "bot-run",
    runId: "run",
    repository: REPOSITORY,
    ref: "c".repeat(40),
    credentialSlot: "github",
  })

  health.mockResolvedValue({
    health: "degraded",
    message: "Missing permissions: issues:write",
    checkedAt: "t",
  } as never)
  f.mocks.acquire.mockRejectedValueOnce(new Error("authentication failed"))
  const g = fixture({ triggerId: "check" })
  ;(g.context.integrations as unknown as { checkAccountHealth: typeof health }).checkAccountHealth =
    health
  g.mocks.acquire.mockRejectedValueOnce(new Error("authentication failed"))
  const broken = await checkReadiness(
    g.context,
    g.run,
    g.config,
    readerFor(g.context, g.run, g.config),
    snapshot({ triggers: [] }),
    { cloneProbe: true }
  )
  expect(broken.ready).toBe(false)
  expect(broken.problems.map((problem) => [problem.code, problem.blocking])).toEqual([
    ["no_ingress", true],
    ["permission_probe_failed", true],
    ["private_clone_unavailable", true],
  ])
  expect(broken.problems[1].detail).toBe("Missing permissions: issues:write")
})
