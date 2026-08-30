/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ProjectMiningRun } from "@/types/memory/governance"
import { ProjectBackfillCard, type ProjectBackfillService } from "./project-backfill-card"

const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }))

function run(over: Partial<ProjectMiningRun> = {}): ProjectMiningRun {
  return {
    id: "r1",
    projectId: "p1",
    status: "preconsent",
    estimate: { sessions: 12, messages: 240, windows: 20, estimatedInputTokens: 52_800 },
    createdAt: 1,
    updatedAt: 1,
    sessionsScanned: 0,
    jobsEnqueued: 0,
    claimsProduced: 0,
    ...over,
  }
}

function service(over: Partial<ProjectBackfillService> = {}): ProjectBackfillService {
  return {
    load: async () => undefined,
    propose: async () => run(),
    confirm: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    ...over,
  }
}

function setup(over: Partial<Parameters<typeof ProjectBackfillCard>[0]> = {}) {
  render(<ProjectBackfillCard projectId="p1" pollMs={0} service={service()} {...over} />)
}

beforeEach(() => mockToastError.mockReset())

it("says which precondition is missing when there is no workspace", () => {
  setup({ projectId: undefined })
  expect(screen.getByText(/Open a workspace to sweep its history/)).toBeTruthy()
})

it("offers only an estimate before a run exists, never a start button", async () => {
  // A sweep costs real money, so nothing here may start one in a single click.
  setup()
  await waitFor(() => expect(screen.getByTestId("memory-backfill-propose")).toBeTruthy())
  expect(screen.queryByTestId("memory-backfill-confirm")).toBeNull()
})

it("proposes a run and then shows the cost before asking for consent", async () => {
  const user = userEvent.setup()
  let current: ProjectMiningRun | undefined
  setup({
    service: service({
      load: async () => current,
      propose: async () => {
        current = run()
        return current
      },
    }),
  })
  await user.click(await screen.findByTestId("memory-backfill-propose"))
  await waitFor(() => expect(screen.getByTestId("memory-backfill-confirm")).toBeTruthy())
  expect(screen.getByText(/12 conversations/)).toBeTruthy()
  expect(screen.getByText(/20 model calls/)).toBeTruthy()
})

it("states the estimate is honest in both directions", async () => {
  setup({ service: service({ load: async () => run() }) })
  await waitFor(() => expect(screen.getByText(/skipped before they reach a model/)).toBeTruthy())
})

it("starts the sweep only on an explicit confirm", async () => {
  const user = userEvent.setup()
  const confirm = jest.fn(async () => undefined)
  setup({ service: service({ load: async () => run(), confirm }) })
  await user.click(await screen.findByTestId("memory-backfill-confirm"))
  expect(confirm).toHaveBeenCalledWith("r1")
})

it("lets a user walk away from the estimate without starting anything", async () => {
  const user = userEvent.setup()
  const cancel = jest.fn(async () => undefined)
  const confirm = jest.fn()
  setup({ service: service({ load: async () => run(), confirm, cancel }) })
  await user.click(await screen.findByTestId("memory-backfill-cancel"))
  expect(cancel).toHaveBeenCalledWith("r1")
  expect(confirm).not.toHaveBeenCalled()
})

it("reports progress against the estimate once the sweep is running", async () => {
  setup({
    service: service({
      load: async () => run({ status: "running", sessionsScanned: 5, claimsProduced: 7 }),
    }),
  })
  await waitFor(() =>
    expect(screen.getByTestId("memory-backfill-progress").textContent).toMatch(
      /5 of 12 conversations checked/
    )
  )
  expect(screen.getByTestId("memory-backfill-progress").textContent).toMatch(/7 facts learned/)
})

it("offers pause while running and resume while paused, never both", async () => {
  const { rerender } = render(
    <ProjectBackfillCard
      projectId="p1"
      pollMs={0}
      service={service({ load: async () => run({ status: "running" }) })}
    />
  )
  await waitFor(() => expect(screen.getByTestId("memory-backfill-pause")).toBeTruthy())
  expect(screen.queryByTestId("memory-backfill-resume")).toBeNull()

  rerender(
    <ProjectBackfillCard
      projectId="p2"
      pollMs={0}
      service={service({ load: async () => run({ status: "paused" }) })}
    />
  )
  await waitFor(() => expect(screen.getByTestId("memory-backfill-resume")).toBeTruthy())
  expect(screen.queryByTestId("memory-backfill-pause")).toBeNull()
})

it("says so when an action fails instead of leaving a dead button", async () => {
  const user = userEvent.setup()
  setup({
    service: service({
      load: async () => run(),
      confirm: async () => {
        throw new Error("dexie closed")
      },
    }),
  })
  await user.click(await screen.findByTestId("memory-backfill-confirm"))
  await waitFor(() => expect(mockToastError).toHaveBeenCalled())
})
