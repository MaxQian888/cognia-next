/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { StorageUsageCard } from "./storage-usage-card"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("<StorageUsageCard />", () => {
  it("renders the supported variant with progress + backup list", async () => {
    render(
      <StorageUsageCard
        fetcher={async () => ({
          totalBytes: 5 * 1024 * 1024,
          quotaBytes: 100 * 1024 * 1024,
          backupBytes: 2 * 1024 * 1024,
          backups: [
            {
              id: "bh_1",
              completedAt: 1_700_000_000_000,
              type: "manual",
              success: true,
              encryption: "passphrase",
              sizeBytes: 2 * 1024 * 1024,
              filename: "cognia-2026-05-20.zip",
              schemaVersion: 3,
            },
          ],
        })}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("storage-usage-card")).toBeInTheDocument()
    })
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
    expect(screen.getByText(/cognia-2026-05-20\.zip/)).toBeInTheDocument()
  })

  it("renders the unsupported variant when totals are null", async () => {
    render(
      <StorageUsageCard
        fetcher={async () => ({
          totalBytes: null,
          quotaBytes: null,
          backupBytes: 0,
          backups: [],
        })}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId("storage-usage-card")).toBeInTheDocument()
    })
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.getByText(/This shell does not expose storage estimates/)).toBeInTheDocument()
  })

  it("renders the empty-backups copy when nothing has been backed up", async () => {
    render(
      <StorageUsageCard
        fetcher={async () => ({
          totalBytes: 100,
          quotaBytes: 1000,
          backupBytes: 0,
          backups: [],
        })}
      />
    )
    await waitFor(() => expect(screen.getByText(/No successful backups yet/)).toBeInTheDocument())
  })

  it("shows the persisted state from the probe", async () => {
    render(
      <StorageUsageCard
        fetcher={async () => ({ totalBytes: 1, quotaBytes: 10, backupBytes: 0, backups: [] })}
        persistedChecker={async () => true}
      />
    )
    await waitFor(() => expect(screen.getByTestId("storage-persisted")).toBeInTheDocument())
    expect(screen.getByText(/Protected from eviction/i)).toBeInTheDocument()
  })

  it("shows the non-persisted warning when the probe returns false", async () => {
    render(
      <StorageUsageCard
        fetcher={async () => ({ totalBytes: 1, quotaBytes: 10, backupBytes: 0, backups: [] })}
        persistedChecker={async () => false}
      />
    )
    await waitFor(() => expect(screen.getByTestId("storage-persisted")).toBeInTheDocument())
    expect(screen.getByText(/may be evicted/i)).toBeInTheDocument()
  })

  it("offers a persistence request only when not persisted, and grants it", async () => {
    const requester = jest.fn(async () => "persisted" as const)
    render(
      <StorageUsageCard
        fetcher={async () => ({ totalBytes: 1, quotaBytes: 10, backupBytes: 0, backups: [] })}
        persistedChecker={async () => false}
        requester={requester}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId("storage-request-persistence")).toBeInTheDocument()
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId("storage-request-persistence"))
    await waitFor(() => expect(requester).toHaveBeenCalled())
    expect(toastSuccess).toHaveBeenCalled()
    // Status flips to granted, so the button disappears.
    await waitFor(() =>
      expect(screen.queryByTestId("storage-request-persistence")).toBeNull()
    )
  })

  it("hides the persistence request when already persisted", async () => {
    render(
      <StorageUsageCard
        fetcher={async () => ({ totalBytes: 1, quotaBytes: 10, backupBytes: 0, backups: [] })}
        persistedChecker={async () => true}
      />
    )
    await waitFor(() => expect(screen.getByTestId("storage-persisted")).toBeInTheDocument())
    expect(screen.queryByTestId("storage-request-persistence")).toBeNull()
  })

  it("toasts an error when the persistence request is denied", async () => {
    const requester = jest.fn(async () => "denied" as const)
    render(
      <StorageUsageCard
        fetcher={async () => ({ totalBytes: 1, quotaBytes: 10, backupBytes: 0, backups: [] })}
        persistedChecker={async () => false}
        requester={requester}
      />
    )
    const user = userEvent.setup()
    await waitFor(() =>
      expect(screen.getByTestId("storage-request-persistence")).toBeInTheDocument()
    )
    await user.click(screen.getByTestId("storage-request-persistence"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("re-runs the fetcher when refresh is pressed", async () => {
    const fetcher = jest.fn(async () => ({
      totalBytes: 1,
      quotaBytes: 10,
      backupBytes: 0,
      backups: [],
    }))
    render(<StorageUsageCard fetcher={fetcher} />)
    await waitFor(() => expect(screen.getByTestId("storage-refresh")).toBeInTheDocument())
    expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("storage-refresh"))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })
})
