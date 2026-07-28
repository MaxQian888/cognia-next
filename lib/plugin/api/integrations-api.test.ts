/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetIntegrationRegistryForTesting,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"
import { createIntegrationsAPI } from "./integrations-api"

describe("ctx.integrations", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
    })
  })

  it("keeps account and subscription mutations behind integrations:manage", async () => {
    const readOnly = createIntegrationsAPI(
      "example-delivery",
      (permission) => permission === "integrations:read"
    )
    await expect(
      readOnly.createAccount({
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "opaque",
        remoteAccountId: "one",
        label: "One",
      })
    ).rejects.toThrow('requires the "integrations:manage" permission')
  })

  it("manages only the calling plugin's accounts through opaque handles", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })
    const subscription = await api.createSubscription({
      integrationId: "example",
      accountId: account.id,
      eventTypes: ["issue.updated"],
    })

    expect(account.authSessionId).toBe("opaque-session-id")
    await expect(api.listAccounts()).resolves.toEqual([account])
    await expect(api.listSubscriptions()).resolves.toEqual([subscription])
    expect(api.listDefinitions().map((definition) => definition.id)).toEqual(["example"])
  })
})
