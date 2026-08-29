/**
 * @jest-environment jsdom
 */
import { fireEvent, render } from "@testing-library/react"
import {
  SchedulerTaskCreateConfig,
  SchedulerTaskListConfig,
  SchedulerTaskUpdateConfig,
  SchedulerTaskIdConfig,
  SchedulerTaskExecutionsConfig,
  SchedulerTaskBackfillConfig,
  SchedulerTaskExportConfig,
  SchedulerTaskImportConfig,
  SchedulerStatusConfig,
  SchedulerStatisticsConfig,
  SchedulerUpcomingConfig,
  SchedulerExecutionsRecentConfig,
  SchedulerExecutionGetConfig,
  SchedulerEventTriggerConfig,
} from "./scheduler-forms"

describe("scheduler-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        SchedulerTaskCreateConfig,
        SchedulerTaskListConfig,
        SchedulerTaskUpdateConfig,
        SchedulerTaskIdConfig,
        SchedulerTaskExecutionsConfig,
        SchedulerTaskBackfillConfig,
        SchedulerTaskExportConfig,
        SchedulerTaskImportConfig,
        SchedulerStatusConfig,
        SchedulerStatisticsConfig,
        SchedulerUpcomingConfig,
        SchedulerExecutionsRecentConfig,
        SchedulerExecutionGetConfig,
        SchedulerEventTriggerConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})

/**
 * `buildSchedulerUpdateInput` maps `clearEndAt: true` to `endAt: null` — the
 * only way to remove a scheduled task's end date. It had no field, so an end
 * date set once could never be taken off from a workflow. The create form must
 * NOT offer it: its schema has no such param.
 */
describe("SchedulerTaskUpdateConfig — clearing the end date", () => {
  it("offers the toggle on update but not on create", () => {
    const { container } = render(<SchedulerTaskUpdateConfig params={{}} onChange={jest.fn()} />)
    expect(container.querySelector('[data-field="clearEndAt"]')).not.toBeNull()

    const created = render(<SchedulerTaskCreateConfig params={{}} onChange={jest.fn()} />)
    expect(created.container.querySelector('[data-field="clearEndAt"]')).toBeNull()
  })

  it("disables the end-date input while clearing is on, because the executor ignores it", () => {
    const { container } = render(
      <SchedulerTaskUpdateConfig
        params={{ endAt: "2026-01-01", clearEndAt: true }}
        onChange={jest.fn()}
      />
    )
    const endAt = container.querySelector('[data-field="endAt"] input') as HTMLInputElement
    expect(endAt).toBeDisabled()
  })

  it("stores the flag only when on, so an untouched node stays minimal", () => {
    const onChange = jest.fn()
    const { container } = render(<SchedulerTaskUpdateConfig params={{}} onChange={onChange} />)
    const toggle = container.querySelector('[data-field="clearEndAt"] button')!
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ clearEndAt: true }))
  })
})
