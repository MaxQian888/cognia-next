/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => true),
}))

import { isTauri } from "@/lib/platform/detect"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

import type { captureProjectRepository } from "@/lib/workspace/project-repository"

import {
  PROJECT_REPOSITORY_SCAN_DELAY_MS,
  ProjectRepositoryInitializer,
} from "./project-repository-initializer"

function project(id: string, path: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    roots: [{ id: `${id}-root`, path, isPrimary: true }],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastAccessedAt: new Date(0),
    ...extra,
  }
}

const isTauriMock = isTauri as jest.Mock

type Capture = typeof captureProjectRepository

function captureMock(
  impl: (...args: Parameters<Capture>) => ReturnType<Capture> = async () => undefined
) {
  return jest.fn<ReturnType<Capture>, Parameters<Capture>>(impl)
}

function setProjects(projects: Project[], loaded = true) {
  useProjectStore.setState({ projects, loaded } as never)
}

beforeEach(() => {
  jest.useFakeTimers()
  isTauriMock.mockReturnValue(true)
  setProjects([])
})
afterEach(() => jest.useRealTimers())

async function elapse(ms = PROJECT_REPOSITORY_SCAN_DELAY_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}

it("reads every workspace after boot settles, then only one whose folder moved", async () => {
  setProjects([
    project("app", "/Users/me/app"),
    project("old", "/Users/me/old", { isArchived: true }),
  ])
  const capture = captureMock()
  render(<ProjectRepositoryInitializer capture={capture} />)
  expect(capture).not.toHaveBeenCalled()
  await elapse()
  expect(capture.mock.calls.map(([item]) => item.id)).toEqual(["app"])

  capture.mockClear()
  // An unrelated change reads nothing.
  act(() => setProjects([project("app", "/Users/me/app", { name: "renamed" })]))
  await elapse(0)
  expect(capture).not.toHaveBeenCalled()

  act(() => setProjects([project("app", "/Users/me/app2"), project("new", "/Users/me/new")]))
  await elapse(0)
  expect(capture.mock.calls.map(([item]) => item.id)).toEqual(["app", "new"])
})

it("records what it reads through the project store", async () => {
  setProjects([project("app", "/Users/me/app")])
  const updateProject = jest.fn()
  useProjectStore.setState({ updateProject } as never)
  const capture = captureMock(async (_project, deps) => {
    deps.update("app", { remoteUrl: "https://github.com/acme/app.git", capturedAt: 1 })
    return undefined
  })
  render(<ProjectRepositoryInitializer capture={capture} />)
  await elapse()
  expect(updateProject).toHaveBeenCalledWith("app", {
    repository: { remoteUrl: "https://github.com/acme/app.git", capturedAt: 1 },
  })
})

it("waits for the list to load, and does nothing off the desktop", async () => {
  setProjects([project("app", "/Users/me/app")], false)
  const capture = captureMock()
  const { unmount } = render(<ProjectRepositoryInitializer capture={capture} />)
  await elapse()
  expect(capture).not.toHaveBeenCalled()
  act(() => setProjects([project("app", "/Users/me/app")], true))
  await elapse(0)
  expect(capture).toHaveBeenCalledTimes(1)
  unmount()

  capture.mockClear()
  isTauriMock.mockReturnValue(false)
  render(<ProjectRepositoryInitializer capture={capture} />)
  await elapse()
  expect(capture).not.toHaveBeenCalled()
})
