/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub Sheet primitives to render inline.
jest.mock("@/components/ui/sheet")

import { SystemTaskInspectSheet } from "./system-task-inspect-sheet"
import type { SystemTask } from "@/types/scheduler"

function buildTask(overrides: Partial<SystemTask> = {}): SystemTask {
  return {
    id: "sys-1",
    name: "Backup",
    description: "Daily backup",
    status: "ready",
    trigger: { type: "cron", expression: "0 2 * * *" },
    action: { type: "run_command", command: "backup.sh" },
    run_level: "highest",
    tags: [],
    metadata_state: "full",
    ...overrides,
  } as unknown as SystemTask
}

describe("SystemTaskInspectSheet", () => {
  it("returns null when task is null", () => {
    const { container } = render(
      <SystemTaskInspectSheet open={true} onOpenChange={jest.fn()} task={null} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("returns null when open is false", () => {
    const { container } = render(
      <SystemTaskInspectSheet open={false} onOpenChange={jest.fn()} task={buildTask()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the task name in the title and the platform/metadata columns", () => {
    render(<SystemTaskInspectSheet open={true} onOpenChange={jest.fn()} task={buildTask()} />)
    expect(screen.getAllByText(/Backup/).length).toBeGreaterThan(0)
    // run_command formatter shows the command verbatim.
    expect(screen.getAllByText("backup.sh").length).toBeGreaterThan(0)
  })

  it("renders degraded reasons when present", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({ degraded_reasons: ["No platform match", "Stale metadata"] })}
      />
    )
    expect(screen.getByText("No platform match")).toBeInTheDocument()
    expect(screen.getByText("Stale metadata")).toBeInTheDocument()
  })

  it("renders interval trigger formatting", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          trigger: { type: "interval", seconds: 60 } as never,
        })}
      />
    )
    expect(screen.getAllByText(/interval: 60s/).length).toBeGreaterThan(0)
  })

  it("renders once trigger formatting", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          trigger: { type: "once", run_at: "2030-01-01T00:00:00Z" } as never,
        })}
      />
    )
    expect(screen.getAllByText(/once:/).length).toBeGreaterThan(0)
  })

  it("renders on_boot trigger formatting", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          trigger: { type: "on_boot", delay_seconds: 30 } as never,
        })}
      />
    )
    expect(screen.getAllByText(/on_boot/).length).toBeGreaterThan(0)
  })

  it("renders on_logon trigger formatting with and without user", () => {
    const { rerender } = render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          trigger: { type: "on_logon", user: "alice" } as never,
        })}
      />
    )
    expect(screen.getAllByText(/on_logon \(alice\)/).length).toBeGreaterThan(0)

    rerender(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          trigger: { type: "on_logon" } as never,
        })}
      />
    )
    expect(screen.getAllByText(/on_logon$/).length).toBeGreaterThan(0)
  })

  it("renders on_event trigger formatting", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          trigger: {
            type: "on_event",
            source: "EventLog",
            event_id: 42,
          } as never,
        })}
      />
    )
    expect(screen.getAllByText(/EventLog:42/).length).toBeGreaterThan(0)
  })

  it("renders execute_script action formatting", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          action: { type: "execute_script", language: "ps1", body: "" } as never,
        })}
      />
    )
    expect(screen.getAllByText(/script \(ps1\)/).length).toBeGreaterThan(0)
  })

  it("renders launch_app action formatting", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          action: { type: "launch_app", path: "C:\\\\app.exe" } as never,
        })}
      />
    )
    expect(screen.getAllByText(/app\.exe/).length).toBeGreaterThan(0)
  })

  it("renders next_run_at and last_run_at rows when present", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          next_run_at: new Date("2030-01-01T00:00:00Z").toISOString(),
          last_run_at: new Date("2029-12-01T00:00:00Z").toISOString(),
        })}
      />
    )
    expect(screen.getByText("nextRun")).toBeInTheDocument()
    expect(screen.getByText("lastRun")).toBeInTheDocument()
  })

  it("renders unknown metadata fallback when metadata_state is partial", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({ metadata_state: "partial" as never })}
      />
    )
    expect(screen.getAllByText(/incomplete/).length).toBeGreaterThan(0)
  })

  it("falls back to '-' for unknown trigger/action types", () => {
    render(
      <SystemTaskInspectSheet
        open={true}
        onOpenChange={jest.fn()}
        task={buildTask({
          trigger: { type: "weird" } as never,
          action: { type: "weird" } as never,
        })}
      />
    )
    // Several InspectRow rows show '-' for empty platform/metadata.
    expect(screen.getAllByText("-").length).toBeGreaterThan(0)
  })
})
