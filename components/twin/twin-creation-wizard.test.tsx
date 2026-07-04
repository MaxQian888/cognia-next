/**
 * Coverage for `<TwinCreationWizard />` — the guided twin-creation flow.
 * Real Dexie under fake-indexeddb; the source uploader, worker-config probe,
 * and job-enqueue modules are stubbed so the test drives the wizard's own
 * orchestration (create → seed → readiness → bind → finish) deterministically.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// The real uploader pulls in document processors + chat importers. Stub it to
// a button that registers one pending source for the twin under test.
jest.mock("./twin-source-uploader", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createTwinSource } = require("@/lib/db/twin-sources")
  return {
    TwinSourceUploader: ({ twinId }: { twinId: string }) =>
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "mock-add-source",
          onClick: () =>
            void createTwinSource({
              twinId,
              kind: "document",
              format: "markdown",
              source: "seed body",
              title: "Seed",
              bytes: 9,
              fingerprint: `fp_${Math.random()}`,
              redacted: false,
              status: "pending",
            }),
        },
        "add source"
      ),
  }
})

// Control runtime readiness directly instead of configuring a real vector
// store / embedding / LLM triplet.
jest.mock("./use-twin-worker", () => ({
  buildTwinWorkerConfig: jest.fn(() => ({})),
  isTwinWorkerConfigComplete: jest.fn(() => true),
}))

jest.mock("@/lib/twin/ingest", () => ({
  enqueueIngestJob: jest.fn(async () => ({ id: "job_ingest" })),
}))
jest.mock("@/lib/twin/distill", () => ({
  enqueueDistillJob: jest.fn(async () => ({ id: "job_distill" })),
}))

import { TwinCreationWizard } from "./twin-creation-wizard"
import { isTwinWorkerConfigComplete } from "./use-twin-worker"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { enqueueDistillJob } from "@/lib/twin/distill"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listTwins } from "@/lib/db/twins"
import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { createCharacter, listCharacters } from "@/lib/db/characters"

const mockedComplete = jest.mocked(isTwinWorkerConfigComplete)

// These are Dexie + RTL integration flows (create → seed → readiness → bind →
// finish) with many serial userEvent interactions; the default 5s per-test
// timeout is borderline under a cold IndexedDB open, so give them headroom.
jest.setTimeout(20000)
const mockedIngest = jest.mocked(enqueueIngestJob)
const mockedDistill = jest.mocked(enqueueDistillJob)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  const db = getDb()
  await Promise.all([
    db.twins.clear(),
    db.twinSources.clear(),
    db.twinJobs.clear(),
    db.characters.clear(),
  ])
  mockedComplete.mockReturnValue(true)
  mockedIngest.mockClear()
  mockedDistill.mockClear()
})

async function advanceToStep2(name = "Alex twin") {
  await userEvent.type(screen.getByTestId("twin-wizard-name"), name)
  await userEvent.click(screen.getByTestId("twin-wizard-next"))
}

describe("TwinCreationWizard", () => {
  it("requires a name before creating the twin", async () => {
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    // The Next button is disabled with an empty name.
    expect(screen.getByTestId("twin-wizard-next")).toBeDisabled()
  })

  it("creates a registry row on step 1 → 2 and applies the picked template color", async () => {
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    await userEvent.click(screen.getByTestId("twin-wizard-template-mentor"))
    await advanceToStep2("Mentor Sam")
    await waitFor(async () => {
      const rows = await listTwins()
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe("Mentor Sam")
      expect(rows[0].color).toBe("oklch(0.72 0.16 300)")
    })
  })

  it("walks the full flow, binds a new character, and queues ingest + distill", async () => {
    const onCreated = jest.fn()
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={onCreated} />)

    // Step 1 → 2
    await advanceToStep2("Support Lead")

    // Step 2: seed a source via the stubbed uploader
    await userEvent.click(await screen.findByTestId("mock-add-source"))
    await screen.findByText(/1 source registered/i)
    await userEvent.click(screen.getByTestId("twin-wizard-next"))

    // Step 3: readiness is forced ready by the mocked worker-config probe
    await screen.findByText(/Runtime is configured/i)
    await userEvent.click(screen.getByTestId("twin-wizard-next"))

    // Step 4: bind a NEW character
    await userEvent.click(await screen.findByTestId("twin-wizard-bind-new"))
    await userEvent.type(await screen.findByTestId("twin-wizard-char-name"), "Alex")
    await userEvent.click(screen.getByTestId("twin-wizard-next"))

    // Step 5: opt into distill, then finish
    const distill = await screen.findByTestId("twin-wizard-queue-distill")
    await userEvent.click(distill)
    await userEvent.click(screen.getByTestId("twin-wizard-done"))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(mockedIngest).toHaveBeenCalledTimes(1)
    expect(mockedDistill).toHaveBeenCalledTimes(1)

    const chars = await listCharacters()
    const bound = chars.find((c) => c.name === "Alex")
    expect(bound?.twinId).toBeTruthy()
    expect(mockedIngest).toHaveBeenCalledWith(expect.objectContaining({ twinId: bound?.twinId }))
  })

  it("does not re-enqueue ingest when Done is retried after a distill failure", async () => {
    const onCreated = jest.fn()
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={onCreated} />)

    await advanceToStep2("Retry twin")
    await userEvent.click(await screen.findByTestId("mock-add-source"))
    await screen.findByText(/1 source registered/i)
    await userEvent.click(screen.getByTestId("twin-wizard-next")) // step 2 → 3
    await userEvent.click(await screen.findByTestId("twin-wizard-next")) // step 3 → 4
    await userEvent.click(await screen.findByTestId("twin-wizard-bind-none"))
    await userEvent.click(screen.getByTestId("twin-wizard-next")) // step 4 → 5

    await userEvent.click(await screen.findByTestId("twin-wizard-queue-distill"))
    // First Done: ingest queues, then the distill enqueue throws.
    mockedDistill.mockRejectedValueOnce(new Error("dexie abort"))
    await userEvent.click(screen.getByTestId("twin-wizard-done"))
    await screen.findByRole("alert")
    expect(onCreated).not.toHaveBeenCalled()
    expect(mockedIngest).toHaveBeenCalledTimes(1)

    // Retry Done: distill re-runs and succeeds; ingest is NOT queued again.
    await userEvent.click(screen.getByTestId("twin-wizard-done"))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(mockedIngest).toHaveBeenCalledTimes(1)
    expect(mockedDistill).toHaveBeenCalledTimes(2)
  })

  it("blocks ingest and skips queueing when the runtime is not configured", async () => {
    mockedComplete.mockReturnValue(false)
    const onCreated = jest.fn()
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={onCreated} />)

    await advanceToStep2("Unconfigured")
    await userEvent.click(await screen.findByTestId("mock-add-source"))
    await screen.findByText(/1 source registered/i)
    await userEvent.click(screen.getByTestId("twin-wizard-next"))

    await screen.findByText(/Runtime not configured yet/i)
    await userEvent.click(screen.getByTestId("twin-wizard-next")) // step 3 → 4
    await screen.findByTestId("twin-wizard-bind-none")
    await userEvent.click(screen.getByTestId("twin-wizard-next")) // step 4 (bind none) → 5

    // The ingest checkbox is disabled — no pending-source ingest is possible.
    expect(await screen.findByTestId("twin-wizard-queue-ingest")).toBeDisabled()
    await userEvent.click(screen.getByTestId("twin-wizard-done"))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(mockedIngest).not.toHaveBeenCalled()
  })

  it("persists identity edits when navigating back then forward (no duplicate row)", async () => {
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    await advanceToStep2("First name")
    await userEvent.click(await screen.findByTestId("twin-wizard-back"))
    const nameInput = screen.getByTestId("twin-wizard-name")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "Renamed twin")
    await userEvent.click(screen.getByTestId("twin-wizard-next"))
    await waitFor(async () => {
      const rows = await listTwins()
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe("Renamed twin")
    })
  })

  it("enables the twin worker from the readiness step", async () => {
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    await advanceToStep2("Worker twin")
    await userEvent.click(screen.getByTestId("twin-wizard-next")) // step 2 → 3
    await userEvent.click(await screen.findByRole("switch", { name: /Enable the twin worker/i }))
    await waitFor(async () => {
      expect((await getTwinRuntimeSettings()).workerEnabled).toBe(true)
    })
  })

  it("cancels from step 1 without creating a twin", async () => {
    const onOpenChange = jest.fn()
    render(<TwinCreationWizard open onOpenChange={onOpenChange} onCreated={jest.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(await listTwins()).toHaveLength(0)
  })

  it("binds an existing character", async () => {
    await createCharacter({ name: "Existing Bot", systemPrompt: "hi" })
    const onCreated = jest.fn()
    render(<TwinCreationWizard open onOpenChange={jest.fn()} onCreated={onCreated} />)

    await advanceToStep2("Reuse twin")
    await userEvent.click(screen.getByTestId("twin-wizard-next")) // step 2 → 3
    await screen.findByTestId("twin-wizard-readiness")
    await userEvent.click(screen.getByTestId("twin-wizard-next")) // step 3 → 4

    await userEvent.click(await screen.findByTestId("twin-wizard-bind-existing"))
    const picker = await screen.findByTestId("twin-wizard-char-existing")
    // Wait for the character live-query to populate the picker before selecting.
    const option = await screen.findByRole("option", { name: "Existing Bot" })
    const existing = (await listCharacters()).find((c) => c.name === "Existing Bot")!
    await userEvent.selectOptions(picker, option)
    await waitFor(() => expect((picker as HTMLSelectElement).value).toBe(existing.id))
    await userEvent.click(screen.getByTestId("twin-wizard-next"))

    await screen.findByTestId("twin-wizard-done")
    await userEvent.click(screen.getByTestId("twin-wizard-done"))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const updated = (await listCharacters()).find((c) => c.id === existing.id)
    expect(updated?.twinId).toBeTruthy()
  })
})
