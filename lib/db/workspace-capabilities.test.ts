/** @jest-environment jsdom */

const resolveScopeProjectId = jest.fn(async (explicit?: string | null) => explicit ?? "active")
jest.mock("./project-scope", () => ({
  resolveScopeProjectId: (explicit?: string | null) => resolveScopeProjectId(explicit),
}))

const get = jest.fn()
jest.mock("./schema", () => ({ getDb: () => ({ projects: { get } }) }))

import { EMPTY_CAPABILITY_OVERLAY } from "@/lib/workspace/capability-overlay"

import { loadWorkspaceCapabilityOverlay } from "./workspace-capabilities"

beforeEach(() => {
  resolveScopeProjectId.mockClear()
  get.mockReset()
  get.mockResolvedValue(undefined)
})

it("reads the active workspace by default", async () => {
  get.mockResolvedValue({ id: "active", capabilityOverlay: { skill: { a: false } } })
  await expect(loadWorkspaceCapabilityOverlay()).resolves.toEqual({ skill: { a: false } })
  expect(resolveScopeProjectId).toHaveBeenCalledWith(null)
  expect(get).toHaveBeenCalledWith("active")
})

it("reads the workspace it was given instead of the one on screen", async () => {
  // A scheduled run belongs to the workspace that scheduled it.
  get.mockResolvedValue({ id: "other", capabilityOverlay: { mcpServer: { m: true } } })
  await expect(loadWorkspaceCapabilityOverlay({ projectId: "other" })).resolves.toEqual({
    mcpServer: { m: true },
  })
  expect(resolveScopeProjectId).toHaveBeenCalledWith("other")
})

it("answers with the global flags when the caller opts out of scoping", async () => {
  await expect(loadWorkspaceCapabilityOverlay({ workspaceScoped: false })).resolves.toBe(
    EMPTY_CAPABILITY_OVERLAY
  )
  expect(get).not.toHaveBeenCalled()
})

it("is empty for a workspace that has no opinions", async () => {
  get.mockResolvedValue({ id: "active" })
  await expect(loadWorkspaceCapabilityOverlay()).resolves.toBe(EMPTY_CAPABILITY_OVERLAY)
})

it("is empty when the workspace row is gone", async () => {
  await expect(loadWorkspaceCapabilityOverlay()).resolves.toBe(EMPTY_CAPABILITY_OVERLAY)
})

it("degrades to no opinion rather than failing the turn", async () => {
  // This runs on the send path; a preference that cannot be read must not
  // take the message down with it.
  get.mockRejectedValue(new Error("db closed"))
  await expect(loadWorkspaceCapabilityOverlay()).resolves.toBe(EMPTY_CAPABILITY_OVERLAY)
})

it("survives a scope resolution failure", async () => {
  resolveScopeProjectId.mockRejectedValueOnce(new Error("no settings"))
  await expect(loadWorkspaceCapabilityOverlay()).resolves.toBe(EMPTY_CAPABILITY_OVERLAY)
})
