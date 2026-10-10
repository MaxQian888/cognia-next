import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockList = jest.fn()
jest.mock("./live-grants-list", () => ({
  LiveGrantsList: (props: Record<string, unknown>) => {
    mockList(props)
    return <div data-testid="grants" />
  },
}))
const mockDialog = jest.fn()
jest.mock("./live-share-dialog", () => ({
  ...jest.requireActual("./live-share-dialog"),
  LiveShareDialog: (props: Record<string, unknown>) => {
    mockDialog(props)
    return <div data-testid="dialog" />
  },
}))

import type { LiveFileShareState } from "@/hooks/filespace/use-live-file-share"
import { DEFAULT_FILE_SHARING_POLICY } from "@/lib/filespace/policy"
import type { ConversationFileSpace, FileSpacePath } from "@/types/filespace"
import type { FileShareStatus } from "@/types/filespace/live"

import {
  LiveSharingSection,
  liveSharingOffered,
  liveSharingSupported,
} from "./live-sharing-section"

const space: ConversationFileSpace = {
  sessionId: "s1",
  status: "available",
  hostId: "host-2",
  mounts: [],
}
const dexie = { uploads: [], artifacts: [] }

function status(policy: object = {}): FileShareStatus {
  return {
    active: true,
    policy: { ...DEFAULT_FILE_SHARING_POLICY, allowProtocolCredentials: true, ...policy },
  } as unknown as FileShareStatus
}

function live(patch: Partial<LiveFileShareState> = {}): LiveFileShareState {
  return {
    status: status(),
    grants: [],
    error: null,
    errorMessage: null,
    loading: false,
    reload: jest.fn(),
    ...patch,
  }
}

function renderSection(
  state: LiveFileShareState,
  request: { seq: number; paths: FileSpacePath[] } | null = null
) {
  const onRequest = jest.fn()
  const onCloseRequest = jest.fn()
  render(
    <LiveSharingSection
      live={state}
      space={space}
      dexie={dexie}
      request={request}
      onRequest={onRequest}
      onCloseRequest={onCloseRequest}
    />
  )
  return { onRequest, onCloseRequest }
}

beforeEach(() => jest.clearAllMocks())

describe("liveSharingSupported / liveSharingOffered", () => {
  it("hides live sharing only on a host that cannot do it", () => {
    expect(liveSharingSupported(live({ error: "file_share_unavailable" }))).toBe(false)
    expect(liveSharingSupported(live({ error: "unknown_command" }))).toBe(false)
    expect(liveSharingSupported(live({ error: "file_share_locked" }))).toBe(true)
  })

  it("offers a new share only when the host would issue one", () => {
    expect(liveSharingOffered(live())).toBe(true)
    expect(liveSharingOffered(live({ status: null }))).toBe(false)
    expect(liveSharingOffered(live({ status: status({ allowLiveGrants: false }) }))).toBe(false)
  })
})

describe("LiveSharingSection", () => {
  it("lists this conversation's shares on its host and starts a new one", async () => {
    const user = userEvent.setup()
    const state = live()
    const { onRequest } = renderSection(state)
    expect(screen.getByTestId("grants")).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-2", onChanged: state.reload })
    )
    await user.click(screen.getByRole("button", { name: "Share as network drive…" }))
    expect(onRequest).toHaveBeenCalledWith([])
  })

  it("renders nothing on a host that cannot share live", () => {
    renderSection(live({ status: null, error: "unknown_command" }))
    expect(screen.queryByTestId("filespace-live-sharing")).toBeNull()
  })

  it("says why a new share cannot start, and keeps the existing ones", () => {
    renderSection(live({ status: status({ allowProtocolCredentials: false }) }))
    const button = screen.getByRole("button", { name: "Share as network drive…" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      "title",
      "Network-drive credentials are turned off by your file-sharing policy."
    )
    expect(screen.getByTestId("grants")).toBeInTheDocument()
  })

  it("explains a host that could not be read", () => {
    renderSection(live({ status: null, error: "file_share_locked", errorMessage: "locked" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Unlock your account")
  })

  it("opens the dialog for a request with its paths and reloads after a share", () => {
    const state = live()
    renderSection(state, { seq: 1, paths: ["/workspace" as FileSpacePath] })
    expect(mockDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        space,
        status: state.status,
        initialSelection: ["/workspace"],
        onCreated: state.reload,
      })
    )
  })
})
