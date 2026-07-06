import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SystemTaskForm } from "./system-task-form"
import type {
  CreateSystemTaskInput,
  SchedulerCapabilities,
  ValidationResult,
} from "@/types/scheduler"

// `SystemTaskForm` creates/edits an OS-level scheduled task. It's props-only:
// trigger/action sub-forms are driven by local state, and the (optional)
// `onValidate` callback debounces backend validation. No Tauri/native call is
// made at render — capabilities and validation arrive purely via props — so it
// renders cleanly in Storybook. Stories vary the initial trigger/action and
// the platform capability matrix.
const meta = {
  title: "Scheduler/SystemTaskForm",
  component: SystemTaskForm,
  parameters: { layout: "padded" },
  args: {
    onSubmit: fn(async () => {}),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SystemTaskForm>

export default meta
type Story = StoryObj<typeof meta>

// Empty create form — defaults to a cron trigger and an execute-script action.
export const CreateCron: Story = {}

// Editing an existing "run command" task seeded from initial values.
export const EditRunCommand: Story = {
  args: {
    initialValues: {
      name: "Rotate application logs",
      description: "Run the log-rotation helper every night.",
      run_level: "user",
      trigger: { type: "cron", expression: "0 0 * * *", timezone: "UTC" },
      action: {
        type: "run_command",
        command: "/usr/bin/logrotate",
        args: ["-f", "/etc/logrotate.conf"],
        working_dir: "/var/log",
      },
    } satisfies Partial<CreateSystemTaskInput>,
  },
}

// Editing a "launch app" task with an interval trigger.
export const EditLaunchApp: Story = {
  args: {
    initialValues: {
      name: "Open dashboard each morning",
      run_level: "user",
      trigger: { type: "interval", seconds: 3600 },
      action: { type: "launch_app", path: "/Applications/Dashboard.app", args: ["--fullscreen"] },
    } satisfies Partial<CreateSystemTaskInput>,
  },
}

// A capability matrix that only offers cron + interval triggers, with a
// contextual backend note for the selected trigger.
const limitedCapabilities: SchedulerCapabilities = {
  os: "linux",
  backend: "systemd",
  available: true,
  can_elevate: true,
  supported_triggers: ["cron", "interval"],
  trigger_capabilities: [
    {
      trigger_type: "cron",
      available: true,
      requires_admin: false,
      constraint_notes: [],
      backend_notes: ["Translated to a systemd OnCalendar= timer."],
    },
    {
      trigger_type: "interval",
      available: true,
      requires_admin: false,
      constraint_notes: [],
      backend_notes: ["Translated to a systemd OnUnitActiveSec= timer."],
    },
  ],
  max_tasks: 50,
}

export const LimitedCapabilities: Story = {
  args: {
    capabilities: limitedCapabilities,
  },
}

// Backend validation surfacing a warning + native representation. The debounced
// `onValidate` fires once the name, trigger, and action are all valid.
export const WithValidationWarning: Story = {
  args: {
    initialValues: {
      name: "Nightly cleanup",
      run_level: "administrator",
      trigger: { type: "cron", expression: "0 3 * * *", timezone: "UTC" },
      action: { type: "run_command", command: "/usr/bin/cleanup", args: ["--all"] },
    } satisfies Partial<CreateSystemTaskInput>,
    onValidate: fn(
      async (): Promise<ValidationResult> => ({
        valid: true,
        errors: [],
        warnings: ["Administrator run level requires an elevated daemon."],
        risk_level: "high",
        requires_admin: true,
        translation: {
          valid: true,
          errors: [],
          warnings: ["Administrator run level requires an elevated daemon."],
          native_representation: "0 3 * * * root /usr/bin/cleanup --all",
        },
      })
    ),
  },
}

// Submitting state — inputs and buttons disabled while the save is in flight.
export const Submitting: Story = {
  args: {
    initialValues: {
      name: "Rotate application logs",
      trigger: { type: "cron", expression: "0 0 * * *", timezone: "UTC" },
      action: { type: "run_command", command: "/usr/bin/logrotate" },
    } satisfies Partial<CreateSystemTaskInput>,
    isSubmitting: true,
  },
}
