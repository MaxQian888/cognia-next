/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { recordCaptureGovernance } from "./capture"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("projects capture metadata without retaining captured content", async () => {
  await recordCaptureGovernance({
    id: "capture-1",
    kind: "url",
    text: "private body",
    sourceUrl: "https://secret.example/path",
    sourceApp: "Browser",
    capturedAt: 100,
    fingerprint: "fingerprint-1",
    enrichment: { via: "url-reader", markdown: "private enrichment" },
  })

  expect(await getDb().governanceEvidence.get("capture-evidence:capture-1")).toMatchObject({
    kind: "capture",
    privacy: { contentCaptured: false },
  })
  const stored = JSON.stringify(await getDb().governanceProvenance.toArray())
  expect(stored).not.toContain("private body")
  expect(stored).not.toContain("secret.example")
  expect(stored).not.toContain("private enrichment")
})
