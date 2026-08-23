/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

let searchParams = "app=review"
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(searchParams),
}))

import { fetchWithAnonymousChallenge, WorkflowPortal } from "./workflow-portal"

const fetchMock = jest.fn()
Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true })
Object.defineProperty(URL, "createObjectURL", {
  value: jest.fn(() => "blob:portal-download"),
  configurable: true,
})
Object.defineProperty(URL, "revokeObjectURL", { value: jest.fn(), configurable: true })
jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

const app = {
  slug: "review",
  kind: "workflow",
  releaseId: "release_1",
  blocks: [
    { id: "header", type: "header", showDescription: true },
    { id: "form", type: "input-form", submitLabel: "Review" },
    { id: "result", type: "result", allowCopy: true, showSources: true },
  ],
  localized: { en: { title: "Release review", description: "Check a release" } },
  theme: { primaryColor: "#4f46e5" },
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", title: "Topic" } },
    required: ["topic"],
  },
  legal: { requireConsent: false },
  resultSharing: { enabled: true, defaultTtlSeconds: 3_600 },
}

beforeEach(() => {
  searchParams = "app=review"
  sessionStorage.clear()
  fetchMock.mockReset()
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ app, sessionToken: "token_1" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ output: { result: "approved" } }) })
})

it("accepts a versioned origin-bound embed session only from its parent window", async () => {
  searchParams = "app=review&embed=1"
  const postMessage = jest.spyOn(window.parent, "postMessage")
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetchMock).not.toHaveBeenCalled()

  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://embed.example",
        source: window.parent,
        data: {
          type: "cognia.workflow-app.init",
          version: 1,
          parentOrigin: "https://embed.example",
          sessionToken: "embed_token_1",
        },
      })
    )
  })

  expect(await screen.findByText("Release review")).toBeInTheDocument()
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/apps/review/bootstrap",
    expect.objectContaining({ headers: { Authorization: "Bearer embed_token_1" } })
  )
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "cognia.workflow-app.ready",
      version: 1,
      releaseId: "release_1",
    }),
    "https://embed.example"
  )
  postMessage.mockRestore()
})

it("bootstraps a verified custom domain without an app slug in the URL", async () => {
  searchParams = ""
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )

  expect(await screen.findByText("Release review")).toBeInTheDocument()
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/portal/bootstrap",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
})

it("solves and retries a server-issued adaptive anonymous challenge", async () => {
  const challenge = {
    status: 429,
    clone: () => challenge,
    json: async () => ({
      code: "anonymous_challenge_required",
      details: {
        challengeToken: "challenge-token",
        difficulty: 1,
        algorithm: "sha256-leading-zero-bits",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
      },
    }),
  }
  fetchMock.mockReset()
  fetchMock.mockResolvedValueOnce(challenge).mockResolvedValueOnce({ status: 200, ok: true })
  const digest = new Uint8Array(32)
  const originalCrypto = globalThis.crypto
  Object.defineProperty(globalThis, "crypto", {
    value: { ...originalCrypto, subtle: { digest: jest.fn(async () => digest.buffer) } },
    configurable: true,
  })

  const response = await fetchWithAnonymousChallenge("/api/apps/review/runs", {
    method: "POST",
    headers: { Authorization: "Bearer session" },
    body: "{}",
  })

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const retryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers
  expect(retryHeaders.get("x-cognia-challenge-token")).toBe("challenge-token")
  expect(retryHeaders.get("x-cognia-challenge-proof")).toBe("0")
  Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true })
})

it("renders a safe schema form and submits to the application API", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )

  expect(await screen.findByText("Release review")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Review" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "August" } })
  fireEvent.click(screen.getByRole("button", { name: "Review" }))

  await waitFor(() => expect(screen.getByText(/approved/)).toBeInTheDocument())
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/apps/review/runs",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        input: { topic: "August" },
        legalConsentGranted: false,
        responseMode: "blocking",
      }),
    })
  )
})

it("submits tagged and corrected feedback for a release-pinned workflow result", async () => {
  fetchMock.mockReset()
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ app, sessionToken: "token_1" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ runId: "run_1", status: "completed", output: { result: "draft" } }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "feedback_1", status: "candidate" }),
    })
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )

  await screen.findByText("Release review")
  fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "August" } })
  fireEvent.click(screen.getByRole("button", { name: "Review" }))
  await screen.findByText(/draft/)
  fireEvent.click(screen.getByRole("button", { name: "Needs improvement" }))
  fireEvent.change(screen.getByLabelText("Feedback tags"), {
    target: { value: "accuracy, release" },
  })
  fireEvent.change(screen.getByLabelText("Corrected answer"), {
    target: { value: "approved" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Submit feedback" }))

  expect(await screen.findByText("Thanks for your feedback.")).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/apps/review/feedback",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        rating: "dislike",
        input: JSON.stringify({ topic: "August" }),
        output: JSON.stringify({ result: "draft" }),
        correction: "approved",
        tags: ["accuracy", "release"],
        runId: "run_1",
        legalConsentGranted: false,
      }),
    })
  )
})

it("creates and revokes a controlled result share for the completed run", async () => {
  fetchMock.mockReset()
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ app, sessionToken: "token_1" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ runId: "run_1", status: "completed", output: { result: "ready" } }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: "share_1",
        url: "https://share.example/view?c=share_1#k=secret",
      }),
    })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ revoked: true }) })
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )

  await screen.findByText("Release review")
  fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: "August" } })
  fireEvent.click(screen.getByRole("button", { name: "Review" }))
  await screen.findByText(/ready/)
  fireEvent.click(screen.getByRole("button", { name: "Create share link" }))

  const link = await screen.findByRole("link", {
    name: "https://share.example/view?c=share_1#k=secret",
  })
  expect(link).toHaveAttribute("rel", "noopener noreferrer")
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    "/api/apps/review/runs/run_1/shares",
    expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer token_1", "Content-Type": "application/json" },
      body: "{}",
    })
  )

  fireEvent.click(screen.getByRole("button", { name: "Revoke share link" }))
  await waitFor(() => expect(screen.queryByRole("link")).not.toBeInTheDocument())
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/apps/review/result-shares/share_1",
    expect.objectContaining({ method: "DELETE" })
  )
})

it("carries the optimistic conversation revision across Chatflow messages", async () => {
  const chatApp = {
    ...app,
    kind: "chatflow",
    blocks: [{ id: "chat", type: "chat", showSources: true }],
    localized: { en: { title: "Assistant" } },
  }
  fetchMock.mockReset()
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ app: chatApp, sessionToken: "token_1" }),
    })
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversationId: "conv_1",
        conversationRevision: 2,
        messageId: "msg_1",
        answer: { text: "First" },
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversationId: "conv_1",
        conversationRevision: 4,
        messageId: "msg_2",
        answer: { text: "Second" },
      }),
    })
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )

  const input = await screen.findByRole("textbox", { name: "Message" })
  fireEvent.change(input, { target: { value: "One" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  expect(await screen.findByText("First")).toBeInTheDocument()
  fireEvent.change(input, { target: { value: "Two" } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
  expect(await screen.findByText("Second")).toBeInTheDocument()

  const second = fetchMock.mock.calls[3]?.[1] as RequestInit
  expect(second.body).toBe(
    JSON.stringify({
      query: "Two",
      conversationId: "conv_1",
      expectedRevision: 2,
      legalConsentGranted: false,
    })
  )
})

it("starts a fixed-release CSV batch and exposes terminal result export", async () => {
  const completed = {
    id: "batch_1",
    status: "completed",
    totalRows: 1,
    queuedRows: 0,
    activeRows: 0,
    waitingRows: 0,
    succeededRows: 1,
    failedRows: 0,
    cancelledRows: 0,
  }
  fetchMock.mockReset()
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ app, sessionToken: "token_1" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({ ok: true, json: async () => completed })
    .mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(["row_number,status\r\n1,succeeded"]),
    })
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )

  await screen.findByText("Release review")
  const file = new File(["topic\r\nAugust"], "batch.csv", { type: "text/csv" })
  fireEvent.change(screen.getByLabelText("CSV batch file"), { target: { files: [file] } })
  fireEvent.click(screen.getByRole("button", { name: "Start batch" }))
  expect(await screen.findByText(/completed: 1\/1 succeeded/)).toBeInTheDocument()
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/apps/review/batches",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ csv: "topic\r\nAugust", legalConsentGranted: false }),
    })
  )

  fireEvent.click(screen.getByRole("button", { name: "Export results" }))
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/apps/review/batches/batch_1/export",
    expect.objectContaining({ headers: { Authorization: "Bearer token_1" } })
  )
})

it("renders, uploads, and submits every durable Human Input field type", async () => {
  const request = {
    id: "hir_1",
    title: "Approval needed",
    message: "Check the generated release.",
    fields: [
      { id: "summary", type: "short-text", label: "Summary", required: true },
      { id: "notes", type: "long-text", label: "Notes" },
      { id: "score", type: "number", label: "Score", min: 1, max: 5 },
      { id: "verified", type: "boolean", label: "Verified" },
      {
        id: "decision",
        type: "single-select",
        label: "Decision",
        options: [
          { value: "ship", label: "Ship" },
          { value: "hold", label: "Hold" },
        ],
      },
      {
        id: "checks",
        type: "multi-select",
        label: "Checks",
        options: [{ value: "security", label: "Security" }],
      },
      { id: "evidence", type: "file", label: "Evidence", accept: ["image/*"] },
      { id: "attachments", type: "file-list", label: "Attachments", maxFiles: 2 },
    ],
    actions: [
      { id: "approve", label: "Approve", tone: "primary" },
      { id: "reject", label: "Reject", tone: "destructive" },
    ],
    completionPolicy: { mode: "all" },
    submittedCount: 1,
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  }
  fetchMock.mockReset()
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ app, sessionToken: "token_1" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [request] })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ref: "cognia-human-input-file:hif_1", name: "proof.png" }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ requestId: "hir_1", completed: true, submittedAt: 10 }),
    })
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowPortal />
    </NextIntlClientProvider>
  )

  expect(await screen.findByText("Approval needed")).toBeInTheDocument()
  expect(screen.getByText(/responses? received/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(/Summary/), { target: { value: "Ready" } })
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Reviewed" } })
  fireEvent.change(screen.getByLabelText("Score"), { target: { value: "5" } })
  fireEvent.click(screen.getByLabelText("Verified"))
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "ship" } })
  fireEvent.click(screen.getByLabelText("Security"))
  const proof = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "proof.png", {
    type: "image/png",
  })
  fireEvent.change(screen.getByLabelText("Evidence"), { target: { files: [proof] } })
  await screen.findByText(/files? uploaded/)
  fireEvent.click(screen.getByRole("button", { name: "Approve" }))

  await waitFor(() => expect(screen.queryByText("Approval needed")).not.toBeInTheDocument())
  const uploadRequest = fetchMock.mock.calls[2]
  expect(uploadRequest?.[0]).toBe("/api/apps/review/human-input/hir_1/files")
  expect(uploadRequest?.[1]).toEqual(
    expect.objectContaining({ method: "POST", body: expect.any(FormData) })
  )
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    "/api/apps/review/human-input/hir_1/submit",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        actionId: "approve",
        values: {
          summary: "Ready",
          notes: "Reviewed",
          score: 5,
          verified: true,
          decision: "ship",
          checks: ["security"],
          evidence: "cognia-human-input-file:hif_1",
        },
      }),
    })
  )
})
