import { fireEvent, render, screen } from "@testing-library/react"

import { AttentionBlock } from "./attention-block"
import type { AttentionSignal } from "@/lib/scheduler/attention"

function signal(
  partial: Partial<AttentionSignal> & Pick<AttentionSignal, "kind">
): AttentionSignal {
  return { id: partial.kind, severity: "attention", ...partial }
}

describe("AttentionBlock", () => {
  it("says nothing needs you and when the next run is", () => {
    const next = {
      taskId: "app:a",
      taskName: "Backup",
      taskType: "backup",
      triggerType: "cron",
      status: "active",
      kind: "backup",
      date: new Date(2026, 8, 14, 3, 0),
    } as const
    render(<AttentionBlock signals={[]} next={next as never} onSelectItem={jest.fn()} />)
    expect(screen.getByTestId("attention-empty")).toHaveTextContent("Nothing needs you")
    expect(screen.getByTestId("attention-empty")).toHaveTextContent(/Next up: Backup/)
  })

  it("says nothing is scheduled when there is no next run", () => {
    render(<AttentionBlock signals={[]} onSelectItem={jest.fn()} />)
    expect(screen.getByTestId("attention-empty")).toHaveTextContent("Nothing is scheduled to run.")
  })

  it("opens the item from an item signal and offers the right action per global signal", () => {
    const onSelectItem = jest.fn()
    const onCancelRun = jest.fn()
    const onRetrySources = jest.fn()
    const onSwitchToPaired = jest.fn()
    const onOpenPolicy = jest.fn()
    render(
      <AttentionBlock
        signals={[
          signal({
            kind: "last-run-failed",
            severity: "critical",
            itemUnifiedId: "app:a",
            itemName: "Digest",
            detail: "timeout",
          }),
          signal({
            kind: "running",
            severity: "info",
            itemUnifiedId: "app:b",
            itemName: "Poll",
            runUnifiedId: "app:r9",
          }),
          signal({
            kind: "source-failed",
            severity: "critical",
            sourceKind: "backup",
            detail: "db locked",
          }),
          signal({ kind: "awaiting-confirmation", count: 2 }),
          signal({ kind: "host-suspended" }),
          signal({ kind: "quota-near-limit", writeSource: "agent", count: 8, limit: 10 }),
        ]}
        onSelectItem={onSelectItem}
        onCancelRun={onCancelRun}
        onRetrySources={onRetrySources}
        onSwitchToPaired={onSwitchToPaired}
        onOpenPolicy={onOpenPolicy}
      />
    )
    expect(screen.getByTestId("attention-last-run-failed")).toHaveTextContent(
      "Digest failed its last run: timeout"
    )
    fireEvent.click(screen.getAllByTestId("attention-open-item")[0])
    expect(onSelectItem).toHaveBeenCalledWith("app:a")

    fireEvent.click(screen.getByTestId("attention-stop"))
    expect(onCancelRun).toHaveBeenCalledWith("app:r9")

    expect(screen.getByTestId("attention-source-failed")).toHaveTextContent(
      "The Backup source failed to load: db locked"
    )
    fireEvent.click(screen.getByTestId("attention-retry"))
    expect(onRetrySources).toHaveBeenCalled()

    expect(screen.getByTestId("attention-awaiting-confirmation")).toHaveTextContent(
      "2 system tasks are waiting for your confirmation"
    )
    fireEvent.click(screen.getByTestId("attention-switch-host"))
    expect(onSwitchToPaired).toHaveBeenCalled()

    expect(screen.getByTestId("attention-quota-near-limit")).toHaveTextContent(
      "agent are at 8 of the 10 allowed"
    )
    fireEvent.click(screen.getByTestId("attention-open-policy"))
    expect(onOpenPolicy).toHaveBeenCalled()
  })

  it("phrases a run waiting on approval by what it is waiting for, and opens its item", () => {
    const onSelectItem = jest.fn()
    const cases: [Partial<AttentionSignal>, string][] = [
      [{}, "Nightly is waiting for your approval"],
      [{ tools: "Bash, Edit" }, "Nightly is waiting for your approval to use Bash, Edit"],
      [{ roots: "/repo" }, "Nightly is waiting for you to trust /repo"],
      [
        { tools: "Bash", roots: "/repo" },
        "Nightly is waiting for your approval to use Bash, and for you to trust /repo",
      ],
    ]
    for (const [extra, text] of cases) {
      const { unmount } = render(
        <AttentionBlock
          signals={[
            signal({
              kind: "needs-approval",
              itemUnifiedId: "app:n",
              itemName: "Nightly",
              ...extra,
            }),
          ]}
          onSelectItem={onSelectItem}
        />
      )
      const row = screen.getByTestId("attention-needs-approval")
      expect(row).toHaveTextContent(text)
      expect(row.dataset.severity).toBe("attention")
      fireEvent.click(screen.getByTestId("attention-open-item"))
      unmount()
    }
    expect(onSelectItem).toHaveBeenCalledWith("app:n")
  })

  it("renders no action when the caller cannot answer the signal", () => {
    render(
      <AttentionBlock signals={[signal({ kind: "host-suspended" })]} onSelectItem={jest.fn()} />
    )
    expect(screen.queryByTestId("attention-switch-host")).not.toBeInTheDocument()
    expect(screen.getByTestId("attention-host-suspended").dataset.severity).toBe("attention")
  })
})
