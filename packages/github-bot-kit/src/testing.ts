/**
 * Test doubles for GitHub Bot suites: an in-memory plugin storage, a durable
 * step runner with the host's memo semantics, and a GitHub read router.
 *
 * Framework-free (no `jest` global), so a suite wraps them in its own mocks.
 * Never imported by plugin entries; the `./testing` subpath keeps it out of
 * their bundles.
 */

export interface MemoryStorage {
  data: Map<string, unknown>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
}

export function memoryStorage(): MemoryStorage {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value)
    },
    delete: async (key) => {
      data.delete(key)
    },
  }
}

/**
 * `run.step.run` as the host implements it: a completed step returns its
 * recorded (cloned) output on replay, a failed one runs again.
 */
export function memoizedStep() {
  const memo = new Map<string, unknown>()
  return {
    memo,
    run: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      if (memo.has(name)) return structuredClone(memo.get(name)) as T
      const result = await fn()
      memo.set(name, structuredClone(result))
      return result
    },
  }
}

export interface GithubFixtureResponse {
  status: number
  headers: Record<string, string>
  data: unknown
}

const RESPONSE = Symbol("github-fixture-response")

/** An explicit response (status, headers) from a route, instead of a 200 with data. */
export function githubResponse(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): GithubFixtureResponse & { [RESPONSE]: true } {
  return { status: init.status ?? 200, headers: init.headers ?? {}, data, [RESPONSE]: true }
}

/**
 * An `authenticatedRequest` stand-in for one repository. `route` gets the
 * repository-relative path (`""` for the repository itself, absolute paths
 * such as `/user` unchanged) and returns data for a 200, a
 * {@link githubResponse}, or `undefined` for a URL the suite did not expect,
 * which fails loudly.
 */
export function routeGithubRequests(
  repository: string,
  route: (path: string, url: string) => unknown
) {
  const prefix = `/repos/${repository}`
  return async (
    _binding: unknown,
    url: string,
    _init?: { method?: string; headers?: Record<string, string> }
  ): Promise<GithubFixtureResponse> => {
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url
    const result = await route(path, url)
    if (result === undefined) throw new Error(`Unexpected fixture URL ${url}`)
    if (result && typeof result === "object" && RESPONSE in result) {
      const { status, headers, data } = result as unknown as GithubFixtureResponse
      return { status, headers, data: structuredClone(data) }
    }
    return { status: 200, headers: {}, data: structuredClone(result) }
  }
}

export * from "./testing-repository"
