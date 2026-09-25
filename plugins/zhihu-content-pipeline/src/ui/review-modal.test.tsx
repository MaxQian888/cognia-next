/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import { Dialog } from "@cognia/plugin-ui"
import manifestJson from "../../plugin.json"
import { PLUGIN_ID } from "../ids"
import { setPipelineDbFromDexie, setReviewHost, type ReviewHost } from "../db/runtime"
import { createFakeDexie, type FakeDexie } from "../db/fake-dexie.test-helpers"
import type { DraftRow, ResearchRow, TopicRow } from "../db/tables"
import { ReviewModal } from "./review-modal"

// A functional `useLiveQuery`: run the querier and re-run it when deps change.
// The fake Dexie is not a real Dexie, so the live-query observer has nothing
// to subscribe to; this keeps the data flow the component sees identical.
jest.mock("@cognia/plugin-ui", () => ({
  ...jest.requireActual<typeof import("@cognia/plugin-ui")>("@cognia/plugin-ui"),
  useLiveQuery: (querier: () => Promise<unknown>, deps?: unknown[]) => {
    const React = jest.requireActual<typeof import("react")>("react")
    const [value, setValue] = React.useState<unknown>(undefined)
    React.useEffect(() => {
      let live = true
      void Promise.resolve(querier()).then((result) => {
        if (live) setValue(result)
      })
      return () => {
        live = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

const EN = manifestJson.i18n.locales.en
const en = (key: keyof typeof EN, params: Record<string, string> = {}) =>
  EN[key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)

const topics: TopicRow[] = [
  {
    id: "t1",
    title: "选题甲：一个相当长的标题，用来确认窄屏下不会被截断或撑破对话框",
    source: "zhihu-hot",
    reason: "理由甲",
    score: 90,
    status: "candidate",
    createdAt: 2,
  },
  { id: "t2", title: "选题乙", source: "weibo", status: "candidate", createdAt: 1 },
  {
    id: "t3",
    title: "已选题",
    source: "zhihu-hot",
    status: "selected",
    createdAt: 3,
    sessionId: "sess_written",
  },
]
const research: ResearchRow[] = [
  {
    id: "r1",
    topicId: "t3",
    kind: "fact",
    content: "一条可引用的事实",
    sourceUrl: "https://example.com/source",
    createdAt: 5,
  },
]
const drafts: DraftRow[] = [
  {
    id: "d1",
    topicId: "t3",
    title: "草稿甲",
    markdownBody: "# 草稿甲\n\n正文",
    images: [],
    status: "draft",
    createdAt: 1,
  },
  { id: "d2", title: "无会话草稿", markdownBody: "x", images: [], status: "draft", createdAt: 0 },
]

let fake: FakeDexie
let host: {
  session: { startSeededSession: jest.Mock; switchSession: jest.Mock }
  clipboard: { writeText: jest.Mock }
  ui: { navigate: jest.Mock; showToast: jest.Mock }
}

function renderModal(onClose = jest.fn()) {
  render(
    <Dialog open>
      <ReviewModal onClose={onClose} modalId="m" />
    </Dialog>
  )
  return onClose
}

beforeEach(() => {
  registerPluginI18n({
    pluginId: PLUGIN_ID,
    messages: {
      en: Object.fromEntries(
        Object.entries(EN).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
      ),
    },
  })
  fake = createFakeDexie({ topics, research, drafts })
  setPipelineDbFromDexie(fake.dexie)
  host = {
    session: {
      startSeededSession: jest.fn(async () => ({ sessionId: "sess_new" })),
      switchSession: jest.fn(async () => undefined),
    },
    clipboard: { writeText: jest.fn(async () => undefined) },
    ui: { navigate: jest.fn(() => true), showToast: jest.fn() },
  }
  setReviewHost(host satisfies ReviewHost)
})

afterEach(() => {
  setPipelineDbFromDexie(null)
  setReviewHost(null)
  unregisterPluginI18n(PLUGIN_ID)
})

describe("ReviewModal", () => {
  it("is a labelled dialog body with no close button or width of its own", async () => {
    renderModal()
    expect(screen.getByRole("heading", { name: en("review.title") })).toBeInTheDocument()
    await screen.findByText(topics[1].title)
    // The host dialog draws the only close control.
    expect(screen.queryByRole("button", { name: /close|关闭/i })).not.toBeInTheDocument()
    const body = screen.getByTestId("zhihu-review")
    expect(body.outerHTML).not.toMatch(/\bw-\[|min\(640px/)
  })

  it("renders candidate topics in full, not truncated", async () => {
    renderModal()
    const title = await screen.findByText(topics[0].title)
    expect(title.className).not.toContain("truncate")
    expect(screen.getByText("理由甲")).toBeInTheDocument()
    // Only candidates are offered.
    expect(
      screen.queryByRole("button", { name: en("review.startWritingAria", { title: "已选题" }) })
    ).not.toBeInTheDocument()
  })

  it("starts a Writer session, then marks the topic selected with the session, and closes", async () => {
    const onClose = renderModal()
    await userEvent.click(
      await screen.findByRole("button", {
        name: en("review.startWritingAria", { title: "选题乙" }),
      })
    )
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(host.session.startSeededSession).toHaveBeenCalledWith(
      expect.objectContaining({
        title: en("session.title", { title: "选题乙" }),
        seedUserMessage: expect.stringContaining("选题乙"),
      })
    )
    expect(fake.rows("topics").get("t2")).toMatchObject({
      status: "selected",
      sessionId: "sess_new",
    })
  })

  it("keeps the topic a candidate and says why when the session cannot start", async () => {
    host.session.startSeededSession.mockRejectedValueOnce(new Error("no chat runtime"))
    const onClose = renderModal()
    await userEvent.click(
      await screen.findByRole("button", {
        name: en("review.startWritingAria", { title: "选题乙" }),
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId("zhihu-review-error")).toHaveTextContent(
        en("review.startFailed", { message: "no chat runtime" })
      )
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(fake.rows("topics").get("t2")?.status).toBe("candidate")
  })

  it("shows the research notes the crew saved, with their source", async () => {
    renderModal()
    const notes = await screen.findByTestId("zhihu-review-research")
    expect(notes).toHaveTextContent("一条可引用的事实")
    expect(notes).toHaveTextContent("已选题")
    expect(within(notes).getByRole("link")).toHaveAttribute("href", "https://example.com/source")
  })

  it("expands, copies and reopens a draft's writing session", async () => {
    const onClose = renderModal()
    const [first] = await screen.findAllByTestId("zhihu-review-draft")

    await userEvent.click(
      within(first).getByRole("button", { name: en("review.draftShowAria", { title: "草稿甲" }) })
    )
    expect(screen.getByTestId("zhihu-review-draft-body")).toHaveTextContent("正文")

    await userEvent.click(
      within(first).getByRole("button", { name: en("review.draftCopyAria", { title: "草稿甲" }) })
    )
    expect(host.clipboard.writeText).toHaveBeenCalledWith("# 草稿甲\n\n正文")
    expect(host.ui.showToast).toHaveBeenCalledWith(en("review.draftCopied"), "success")

    await userEvent.click(
      within(first).getByRole("button", {
        name: en("review.draftOpenSessionAria", { title: "草稿甲" }),
      })
    )
    await waitFor(() => expect(host.session.switchSession).toHaveBeenCalledWith("sess_written"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("offers no session link for a draft whose topic never opened one", async () => {
    renderModal()
    const [, second] = await screen.findAllByTestId("zhihu-review-draft")
    expect(
      within(second).queryByRole("button", {
        name: en("review.draftOpenSessionAria", { title: "无会话草稿" }),
      })
    ).not.toBeInTheDocument()
  })

  it("reports a copy that failed", async () => {
    host.clipboard.writeText.mockRejectedValueOnce(new Error("denied"))
    renderModal()
    const [first] = await screen.findAllByTestId("zhihu-review-draft")
    await userEvent.click(
      within(first).getByRole("button", { name: en("review.draftCopyAria", { title: "草稿甲" }) })
    )
    await waitFor(() =>
      expect(screen.getByTestId("zhihu-review-error")).toHaveTextContent(
        en("review.draftCopyFailed", { message: "denied" })
      )
    )
  })

  it("guides the empty state to the topic workflow", async () => {
    setPipelineDbFromDexie(createFakeDexie().dexie)
    const onClose = renderModal()
    const empty = await screen.findByTestId("zhihu-review-empty")
    expect(empty).toHaveTextContent("知乎选题候选")
    await userEvent.click(within(empty).getByRole("button", { name: en("review.openWorkflows") }))
    expect(host.ui.navigate).toHaveBeenCalledWith("/workflows")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("says the data could not be read instead of showing it as empty", async () => {
    fake.failTable("topics", new Error("idb closed"))
    renderModal()
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        en("review.loadFailed", { message: "idb closed" })
      )
    )
  })

  it("explains a shell without storage", async () => {
    setPipelineDbFromDexie(null)
    renderModal()
    expect(await screen.findByTestId("zhihu-review-no-storage")).toHaveTextContent(
      en("review.storageUnavailable")
    )
  })

  it("keeps every action at least 36px tall on narrow screens", async () => {
    renderModal()
    await screen.findAllByTestId("zhihu-review-draft")
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toMatch(/(^|\s)h-9(\s|$)/)
    }
  })
})
