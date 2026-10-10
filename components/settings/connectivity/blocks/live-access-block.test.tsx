import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockList = jest.fn()
jest.mock("@/components/filespace/live-grants-list", () => ({
  LiveGrantsList: (props: Record<string, unknown>) => {
    mockList(props)
    return <div data-testid="grants" />
  },
}))
const mockAudit = jest.fn()
jest.mock("@/components/filespace/live-share-audit", () => ({
  LiveShareAudit: (props: Record<string, unknown>) => {
    mockAudit(props)
    return <div data-testid="audit" />
  },
}))

import type { LiveFileShareState } from "@/hooks/filespace/use-live-file-share"
import type { Transport } from "@/lib/tauri/transport-types"
import type { FileShareStatus, LiveGrantView } from "@/types/filespace/live"

import { LiveAccessBlock } from "./live-access-block"

const transport = { call: jest.fn() } as unknown as Transport
const status = { activeGrants: 2, liveConnections: 3 } as FileShareStatus
const live: LiveFileShareState = {
  status,
  grants: [{ grant: { id: "g" } } as LiveGrantView],
  error: null,
  errorMessage: null,
  loading: false,
  reload: jest.fn(),
}

it("lists every share on the host with its conversation", () => {
  render(<LiveAccessBlock live={live} status={status} transport={transport} />)
  expect(screen.getByText("2 active shares · 3 connections")).toBeInTheDocument()
  expect(mockList).toHaveBeenCalledWith(
    expect.objectContaining({
      grants: live.grants,
      status,
      transport,
      showConversation: true,
      onChanged: live.reload,
    })
  )
})

it("keeps the host-wide activity folded until asked", async () => {
  const user = userEvent.setup()
  render(<LiveAccessBlock live={live} status={status} transport={transport} />)
  expect(mockAudit).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: /Activity/ }))
  expect(mockAudit).toHaveBeenCalledWith({ transport })
})
