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
