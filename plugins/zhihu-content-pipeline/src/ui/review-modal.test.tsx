/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { useLiveQuery } from "dexie-react-hooks"
import { createSession } from "@/lib/db/sessions"
import { ReviewModal } from "./review-modal"
import { __setPipelineDbForTesting } from "../db/runtime"
import type { DraftRow, TopicRow } from "../db/tables"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("next-intl", () => ({ useLocale: () => "zh-CN" }))
jest.mock("@/lib/db/sessions", () => ({ createSession: jest.fn(async () => ({ id: "sess_1" })) }))
jest.mock("@/lib/db/messages", () => ({ persistMessages: jest.fn(async () => undefined) }))
jest.mock("@/lib/claude/adapter", () => ({
  makeUserMessage: (text: string) => ({ id: "m", role: "user", parts: [{ type: "text", text }] }),
}))
const setActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: { setActiveSession: () => void }) => unknown) =>
    sel({ setActiveSession }),
}))

const mockLive = useLiveQuery as jest.Mock
const mockCreateSession = createSession as jest.Mock

const topics: TopicRow[] = [
  {
    id: "t1",
    title: "选题甲",
    source: "zhihu-hot",
    reason: "理由甲",
    score: 90,
    status: "candidate",
    createdAt: 2,
  },
  // No reason / no score — exercises the optional render branches.
  { id: "t2", title: "选题乙", source: "weibo", status: "candidate", createdAt: 1 },
]
const drafts: DraftRow[] = [
  { id: "d1", title: "草稿甲", markdownBody: "x", images: [], status: "draft", createdAt: 1 },
]

const fakeDb = {
  listTopics: jest.fn(),
  listDrafts: jest.fn(),
  setTopicStatus: jest.fn(async () => undefined),
}

beforeEach(() => {
  jest.clearAllMocks()
  __setPipelineDbForTesting(fakeDb as never)
  let call = 0
  mockLive.mockImplementation(() => (call++ % 2 === 0 ? topics : drafts))
})
afterEach(() => __setPipelineDbForTesting(null))

describe("ReviewModal", () => {
  it("renders candidate topics and drafts", () => {
    render(<ReviewModal onClose={jest.fn()} modalId="m" />)
    expect(screen.getByText("选题甲")).toBeInTheDocument()
    expect(screen.getByText("理由甲")).toBeInTheDocument()
    expect(screen.getByText("草稿甲")).toBeInTheDocument()
  })

  it("starts writing for a topic and closes", async () => {
    const onClose = jest.fn()
    render(<ReviewModal onClose={onClose} modalId="m" />)
    fireEvent.click(screen.getByRole("button", { name: "开始写作：选题甲" }))
    await waitFor(() => expect(mockCreateSession).toHaveBeenCalledTimes(1))
    expect(fakeDb.setTopicStatus).toHaveBeenCalledWith("t1", "selected")
    expect(setActiveSession).toHaveBeenCalledWith("sess_1")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("no-ops the handoff when no pipeline DB is published", async () => {
    __setPipelineDbForTesting(null)
    render(<ReviewModal onClose={jest.fn()} modalId="m" />)
    fireEvent.click(screen.getByRole("button", { name: "开始写作：选题甲" }))
    await waitFor(() => expect(mockCreateSession).not.toHaveBeenCalled())
  })

  it("shows the empty state when there are no candidates", () => {
    let call = 0
    mockLive.mockImplementation(() => (call++ % 2 === 0 ? [] : []))
    render(<ReviewModal onClose={jest.fn()} modalId="m" />)
    expect(screen.getByText(/还没有候选选题/)).toBeInTheDocument()
    expect(screen.getByText(/还没有草稿/)).toBeInTheDocument()
  })

  it("shows a loading state while the live query is undefined", () => {
    mockLive.mockImplementation(() => undefined)
    render(<ReviewModal onClose={jest.fn()} modalId="m" />)
    expect(screen.getAllByText("加载中…").length).toBeGreaterThan(0)
  })
})
