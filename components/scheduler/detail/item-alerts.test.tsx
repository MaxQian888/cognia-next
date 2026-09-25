import { render, screen } from "@testing-library/react"

import { ItemAlerts } from "./item-alerts"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import type { ScheduledTask } from "@/types/scheduler"
import type { SystemTask } from "@/types/scheduler/system-scheduler"

describe("ItemAlerts", () => {
  it("renders nothing when there is nothing wrong", () => {
    const { container } = render(<ItemAlerts signals={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("states each signal, with the host reason for an unsupported type", () => {
    const signals: AttentionSignal[] = [
      {
        id: "a",
        kind: "last-run-failed",
        severity: "critical",
        itemUnifiedId: "app:a",
        itemName: "Digest",
        detail: "timeout",
      },
      {
        id: "b",
        kind: "unsupported-type",
        severity: "attention",
        itemUnifiedId: "app:a",
        itemName: "Digest",
        reason: "missing-capability",
        missing: "shell",
      },
    ]
    render(<ItemAlerts signals={signals} task={{ type: "background-command" } as ScheduledTask} />)
    expect(screen.getByTestId("item-alert-a")).toHaveTextContent(
      "Digest failed its last run: timeout"
    )
    expect(screen.getByTestId("item-alert-a").dataset.severity).toBe("critical")
    expect(screen.getByTestId("item-alert-b")).toHaveTextContent("Needs the shell capability")
  })

  it("says what a run is waiting on and how to clear it", () => {
    const base = {
      kind: "needs-approval",
      severity: "attention",
      itemUnifiedId: "app:a",
      itemName: "Digest",
    } as const
    render(
      <ItemAlerts
        signals={[
          { ...base, id: "both", tools: "Bash", roots: "/repo" },
          { ...base, id: "trust", roots: "/repo" },
          { ...base, id: "bare" },
        ]}
      />
    )
    const both = screen.getByTestId("item-alert-both")
    expect(both).toHaveTextContent(
      "Digest is waiting for your approval to use Bash, and for you to trust /repo"
    )
    expect(both).toHaveTextContent("allowed tools, or raise its permission mode")
    expect(both).toHaveTextContent("Trust the workspace")
    expect(both.dataset.severity).toBe("attention")

    const trust = screen.getByTestId("item-alert-trust")
    expect(trust).toHaveTextContent("Digest is waiting for you to trust /repo")
    expect(trust).not.toHaveTextContent("allowed tools")

    // Nothing known to name: the sentence alone, no empty hint.
    const bare = screen.getByTestId("item-alert-bare")
    expect(bare).toHaveTextContent("Digest is waiting for your approval")
    expect(bare.querySelector("[data-slot='alert-description']")).toBeNull()
  })

  it("shows the deprecated banner once, not twice, and the OS degradation", () => {
    const signals: AttentionSignal[] = [
      {
        id: "u",
        kind: "unsupported-type",
        severity: "attention",
        itemUnifiedId: "app:a",
        reason: "deprecated-type",
      },
    ]
    render(
      <ItemAlerts
        signals={signals}
        task={{ type: "sync" } as ScheduledTask}
        systemTask={{ degraded_reasons: ["launchd plist missing"] } as SystemTask}
      />
    )
    expect(screen.getByTestId("item-alert-deprecated")).toHaveTextContent("deprecated")
    expect(screen.queryByTestId("item-alert-u")).not.toBeInTheDocument()
    expect(screen.getByTestId("item-alert-degraded")).toHaveTextContent("launchd plist missing")
  })
})
