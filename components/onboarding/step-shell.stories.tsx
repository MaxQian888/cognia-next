import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { Button } from "@/components/ui/button"
import { ExpressScene } from "./scenes/express-scene"
import { ExpressStep } from "./steps/express-step"
import { FirstRunScene } from "./scenes/first-run-scene"
import { FirstRunStep } from "./steps/first-run-step"
import { ProviderScene } from "./scenes/provider-scene"
import { ProviderStep, type ProviderView } from "./steps/provider-step"
import { ScanScene } from "./scenes/scan-scene"
import { ScanStep } from "./steps/scan-step"
import { StepShell } from "./step-shell"
import { WelcomeScene } from "./scenes/welcome-scene"
import { WelcomeStep } from "./steps/welcome-step"
import { resolveStepSequence } from "@/lib/onboarding/steps"
import type { ExpressPlanItem } from "@/lib/onboarding/express-plan"
import type { HistoryImport } from "@/hooks/onboarding/use-history-import"
import type { MachineScan } from "@/hooks/onboarding/use-machine-scan"

/**
 * The first-run takeover. Rendered `fullscreen` because that is what it is: on
 * `/onboarding` the desktop chrome is suppressed and this shell *is* the
 * window, down to its own drag region and window buttons.
 *
 * Use the toolbar's theme switch on every story — the brand substrate, the
 * scenes and the plan lines all derive from CSS variables that have two sets
 * of values, and the version this replaced hard-coded `dark` on its rail and
 * handed a light-theme user a black slab.
 */
const meta = {
  title: "Onboarding/StepShell",
  component: StepShell,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StepShell>

export default meta
type Story = StoryObj<typeof meta>

const expressSequence = resolveStepSequence({
  shell: "tauri",
  mode: "express",
  hasModelAccess: false,
})
const customSequence = resolveStepSequence({
  shell: "tauri",
  mode: "custom",
  hasModelAccess: false,
})

/** A machine with Claude Code installed and signed in, plus Codex alongside. */
const FOUND_SCAN: MachineScan = {
  phase: "found",
  result: {
    runtimes: [
      { id: "claude-code", label: "Claude Code", authenticated: true },
      { id: "codex", label: "Codex", authenticated: false },
    ],
    migratable: [
      { vendor: "claude-code", installed: true, configPath: "~/.claude" },
      { vendor: "codex", installed: true, configPath: "~/.codex" },
    ],
    capabilities: ["fs", "ocr", "web"],
  },
  rescan: () => {},
}

const SCANNING: MachineScan = {
  phase: "scanning",
  result: { runtimes: [], migratable: [], capabilities: ["fs", "web"] },
  rescan: () => {},
}

const HISTORY: HistoryImport = {
  phase: "found",
  total: 128,
  sources: [
    { sourceId: "claude-code", label: "Claude Code", sessions: 96 },
    { sourceId: "gemini-cli", label: "Gemini CLI", sessions: 32 },
  ],
  imported: 0,
  progress: 0,
  partial: false,
  importAll: async () => {},
}

const RICH_PLAN: ExpressPlanItem[] = [
  {
    id: "migrate-claude-code",
    kind: "migrate-config",
    vendor: "claude-code",
    label: "Claude Code",
    selected: true,
    required: false,
  },
  {
    id: "migrate-codex",
    kind: "migrate-config",
    vendor: "codex",
    label: "Codex",
    selected: true,
    required: false,
  },
  { id: "history", kind: "import-history", count: 128, selected: true, required: false },
  { id: "runtime", kind: "use-runtime", label: "Claude Code", selected: true, required: true },
  {
    id: "capabilities",
    kind: "capabilities",
    capabilities: ["fs", "ocr", "web"],
    count: 3,
    selected: true,
    required: true,
  },
]

/** A machine with nothing installed — the majority first run. */
const FRESH_PLAN: ExpressPlanItem[] = [
  { id: "sign-in", kind: "sign-in", selected: true, required: true },
  {
    id: "capabilities",
    kind: "capabilities",
    capabilities: ["fs", "web"],
    count: 2,
    selected: true,
    required: true,
  },
]

const skipFooter = (
  <Button variant="ghost" size="sm">
    Skip for now
  </Button>
)

/** The front door: the path fork as a primary button and a quiet link. */
export const Welcome: Story = {
  args: {
    sequence: expressSequence,
    current: "welcome",
    scene: <WelcomeScene />,
    showStepper: false,
    children: null,
  },
  render: (args) => (
    <StepShell {...args}>
      <WelcomeStep shell="tauri" onStart={() => {}} onCustomise={() => {}} />
    </StepShell>
  ),
}

/**
 * The recommended path on a machine that already has agents on it. Uncheck a
 * line and watch the matching node in the scene go dashed — the picture and
 * the list read from one selection.
 */
export const ExpressPlan: Story = {
  args: {
    sequence: expressSequence,
    current: "express",
    scene: null,
    showStepper: false,
    children: null,
  },
  render: (args) => {
    const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set())
    const toggle = (id: string) =>
      setDropped((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    const items = RICH_PLAN.map((item) => ({
      ...item,
      selected: item.required || !dropped.has(item.id),
    }))
    return (
      <StepShell
        {...args}
        onBack={() => {}}
        footer={skipFooter}
        scene={
          <ExpressScene
            items={items.map((item) => ({
              id: item.id,
              state: item.selected ? "queued" : "skipped",
            }))}
          />
        }
      >
        <ExpressStep
          items={items}
          phase="plan"
          modelAccess
          dropped={dropped}
          onToggle={toggle}
          onApply={() => {}}
        />
      </StepShell>
    )
  },
}

/** Halfway through applying: two lines done, one running. */
export const ExpressApplying: Story = {
  args: {
    sequence: expressSequence,
    current: "express",
    scene: (
      <ExpressScene
        items={[
          { id: "migrate-claude-code", state: "done" },
          { id: "migrate-codex", state: "done" },
          { id: "history", state: "running" },
          { id: "runtime", state: "queued" },
          { id: "capabilities", state: "queued" },
        ]}
      />
    ),
    narrativeKey: "express-applying",
    showStepper: false,
    busy: true,
    children: null,
  },
  render: (args) => (
    <StepShell {...args}>
      <ExpressStep
        items={RICH_PLAN}
        phase="applying"
        status={{
          "migrate-claude-code": "done",
          "migrate-codex": "done",
          history: "running",
        }}
        modelAccess
        dropped={new Set()}
        onToggle={() => {}}
        onApply={() => {}}
      />
    </StepShell>
  ),
}

/** A fresh machine: the plan collapses to sign in, and here is what you get. */
export const ExpressFreshMachine: Story = {
  args: {
    sequence: expressSequence,
    current: "express",
    scene: (
      <ExpressScene
        items={[
          { id: "sign-in", state: "queued" },
          { id: "capabilities", state: "queued" },
        ]}
      />
    ),
    showStepper: false,
    children: null,
  },
  render: (args) => (
    <StepShell {...args} onBack={() => {}} footer={skipFooter}>
      <ExpressStep
        items={FRESH_PLAN}
        phase="plan"
        modelAccess={false}
        dropped={new Set()}
        onToggle={() => {}}
        onApply={() => {}}
        signIn={
          <Button size="sm" className="self-start">
            Sign in with Anthropic
          </Button>
        }
      />
    </StepShell>
  ),
}

/** The step-by-step path's scan step — the scene is driven by the probe. */
export const CustomScan: Story = {
  args: {
    sequence: customSequence,
    current: "scan",
    scene: <ScanScene phase="found" runtimes={FOUND_SCAN.result.runtimes} historyCount={128} />,
    children: null,
  },
  render: (args) => (
    <StepShell {...args} onBack={() => {}} footer={skipFooter}>
      <ScanStep
        shell="tauri"
        scan={FOUND_SCAN}
        history={HISTORY}
        onImport={async () => {}}
        onImportHistory={async () => {}}
      />
    </StepShell>
  ),
}

/** Still probing: the empty slots sequence while work is genuinely in flight. */
export const CustomScanScanning: Story = {
  args: {
    sequence: customSequence,
    current: "scan",
    scene: <ScanScene phase="scanning" runtimes={[]} />,
    children: null,
  },
  render: (args) => (
    <StepShell {...args} onBack={() => {}} footer={skipFooter}>
      <ScanStep
        shell="tauri"
        scan={SCANNING}
        history={{ ...HISTORY, phase: "scanning", total: 0, sources: [] }}
        onImport={async () => {}}
        onImportHistory={async () => {}}
      />
    </StepShell>
  ),
}

/**
 * Sign-in, wired the way `OnboardingFlow` wires it: the action row's Continue
 * stands down while the API-key panel owns the primary button.
 */
export const CustomSignIn: Story = {
  args: {
    sequence: customSequence,
    current: "provider",
    scene: <ProviderScene />,
    children: null,
  },
  render: (args) => {
    const [view, setView] = useState<ProviderView>("chooser")
    return (
      <StepShell
        {...args}
        onBack={() => {}}
        scene={<ProviderScene connected={view === "connected"} />}
        footer={
          <>
            <Button variant="ghost" size="sm">
              Skip for now
            </Button>
            {view === "chooser" && <Button size="sm">Continue</Button>}
          </>
        }
      >
        <ProviderStep onConnected={() => {}} onViewChange={setView} />
      </StepShell>
    )
  },
}

/** The terminal step: the cards are the action, so the row carries only Skip. */
export const CustomFirstRun: Story = {
  args: {
    sequence: customSequence,
    current: "first-run",
    scene: <FirstRunScene />,
    children: null,
  },
  render: (args) => (
    <StepShell {...args} onBack={() => {}} footer={skipFooter}>
      <FirstRunStep
        shell="tauri"
        capabilities={["fs", "ocr", "web"]}
        modelAccess
        character={null}
        onChangeCharacter={() => {}}
        onPick={async () => {}}
        runtimeLabel="Claude Code"
      />
    </StepShell>
  ),
}
