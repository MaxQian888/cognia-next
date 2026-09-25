/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { CopilotKnowledge } from "@/lib/reply-copilot/knowledge"
import type { CopilotResult } from "@/lib/reply-copilot/run-copilot"
import { CopilotResultCard } from "./copilot-result-card"

const copy = jest.fn(async () => true)
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copy, copied: false, isCopying: false }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const knowledge: CopilotKnowledge = {
  relationship: "manager",
  background: "",
  contactId: "pid_1",
  contactName: "Ann",
  hasNote: true,
  memoryLines: 0,
  memorySkipped: "disabled",
}

const judged: CopilotResult = {
  variant: "compact",
  judge: {
    kind: "ok",
    providerId: "laya:laya-local",
    latencyMs: 60,
    truncated: true,
    backgroundDropped: false,
    judgment: {
      literal: 0.2,
      intent: { key: "confirm_you_care", confidence: 0.6, probabilities: {} },
      danger: { level: 5.4, levels: 10, confidence: 0.5 },
      substanceNow: 0.2,
      bestAction: { key: "check_history", confidence: 0.7, probabilities: {} },
      need: { key: "care", confidence: 0.8, probabilities: {} },
      tensionResolved: 0.1,
    },
  },
  drafts: {
    kind: "ok",
    ranked: true,
    candidates: [
      { text: "我查一下再回你", probability: 0.7, slot: 2 },
      { text: "没忘", probability: 0.2, slot: 0 },
    ],
  },
}

describe("CopilotResultCard", () => {
  it("renders the read of the conversation with the danger tone", () => {
    render(<CopilotResultCard result={judged} knowledge={knowledge} />)
    expect(screen.getByText(/judge\.danger:\{"level":5\}/)).toHaveTextContent("tone.tense")
    expect(screen.getByText(/intent\.confirm_you_care/)).toBeInTheDocument()
    expect(screen.getByText(/need\.care/)).toBeInTheDocument()
    expect(screen.getByText(/action\.check_history/)).toBeInTheDocument()
    expect(screen.getByText('judge.subtext:{"p":80}')).toBeInTheDocument()
    expect(screen.getByText('judge.holdingLine:{"p":80}')).toBeInTheDocument()
    expect(screen.getByText('judge.tensionOpen:{"p":90}')).toBeInTheDocument()
    expect(screen.getByText("judge.truncated")).toBeInTheDocument()
  })

  it("marks the best-ranked draft and fills / copies without sending", () => {
    const onFill = jest.fn()
    render(<CopilotResultCard result={judged} knowledge={knowledge} onFill={onFill} />)
    const candidates = screen.getAllByTestId("copilot-candidate")
    expect(candidates[0]).toHaveTextContent('drafts.best:{"p":70}')
    expect(candidates[1]).toHaveTextContent('drafts.score:{"p":20}')
    fireEvent.click(screen.getAllByText("drafts.fill")[0])
    expect(onFill).toHaveBeenCalledWith("我查一下再回你")
    fireEvent.click(screen.getAllByRole("button", { name: "drafts.copy" })[1])
    expect(copy).toHaveBeenCalledWith("没忘")
  })

  it("labels the no-provider state and unranked drafts explicitly", () => {
    render(
      <CopilotResultCard
        result={{
          variant: "full",
          judge: { kind: "unavailable", reason: "no_provider" },
          drafts: {
            kind: "ok",
            ranked: false,
            rankSkipped: "no_provider",
            candidates: [{ text: "好", probability: null, slot: 0 }],
          },
        }}
        knowledge={null}
      />
    )
    expect(screen.getByTestId("copilot-judge-unavailable")).toHaveTextContent(
      "judge.unavailable.no_provider"
    )
    expect(screen.getByTestId("copilot-unranked")).toHaveTextContent(
      "drafts.unrankedReason.no_provider"
    )
    expect(screen.queryByText("drafts.fill")).not.toBeInTheDocument() // overlay: no composer
  })

  it("explains failures and skipped drafts", () => {
    render(
      <CopilotResultCard
        result={{
          variant: "full",
          judge: { kind: "failed", reason: "timeout" },
          drafts: { kind: "skipped", reason: "no-model" },
        }}
        knowledge={knowledge}
      />
    )
    expect(screen.getByTestId("copilot-judge-failed")).toHaveTextContent("judge.failed")
    expect(screen.getByText("drafts.skipped.no-model")).toBeInTheDocument()
  })

  it("expands the context summary", () => {
    render(<CopilotResultCard result={judged} knowledge={knowledge} />)
    fireEvent.click(screen.getByRole("button", { name: /knowledge\.summary/ }))
    expect(
      screen.getByText('knowledge.relationship:{"relationship":"manager"}')
    ).toBeInTheDocument()
    expect(screen.getByText("knowledge.note")).toBeInTheDocument()
    expect(screen.getByText("knowledge.memorySkipped.disabled")).toBeInTheDocument()
  })

  it("says why a provider that is not validated did not judge or rank", () => {
    render(
      <CopilotResultCard
        result={{
          variant: "compact",
          judge: { kind: "unavailable", reason: "not_validated" },
          drafts: {
            kind: "ok",
            ranked: false,
            rankSkipped: "not_validated",
            candidates: [{ text: "好", probability: null, slot: 0 }],
          },
        }}
        knowledge={null}
      />
    )
    expect(screen.getByTestId("copilot-judge-unavailable")).toHaveTextContent(
      "judge.unavailable.not_validated"
    )
    expect(screen.getByTestId("copilot-unranked")).toHaveTextContent(
      "drafts.unrankedReason.not_validated"
    )
  })
})
