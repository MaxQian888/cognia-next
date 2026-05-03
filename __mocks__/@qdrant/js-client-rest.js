/**
 * Manual Jest mock for `@qdrant/js-client-rest`.
 *
 * The real package ships a browser-only ESM bundle that Jest's CJS runtime
 * can't parse, and the existing tests assert against `client.X` as auto-mocks
 * (e.g. `expect(client.upsert).toHaveBeenCalledWith(...)`,
 * `(client.query as jest.Mock).mockResolvedValue(...)`). Manual mocks under
 * `__mocks__/<scope>/<name>.js` are picked up automatically — no
 * `jest.mock(...)` call needed in the test file.
 *
 * Each instance gets its own per-method `jest.fn()` so per-test
 * `mockResolvedValue` overrides don't leak across instances. The defaults
 * resolve with empty / no-op values that match the shapes the real client
 * returns; tests that need specific data set their own `mockResolvedValue`.
 */

function defaultGetCollection() {
  return Promise.resolve({
    indexed_vectors_count: 0,
    points_count: 0,
    status: "green",
    config: {
      params: {
        vectors: {
          size: 0,
          distance: "Cosine",
        },
      },
    },
  })
}

const QdrantClient = jest.fn().mockImplementation(function () {
  this.createCollection = jest.fn(() => Promise.resolve({ result: true, status: "ok" }))
  this.deleteCollection = jest.fn(() => Promise.resolve(true))
  this.getCollection = jest.fn(defaultGetCollection)
  this.getCollections = jest.fn(() => Promise.resolve({ collections: [] }))
  this.upsert = jest.fn(() => Promise.resolve({ operation_id: 1, status: "completed" }))
  this.delete = jest.fn(() => Promise.resolve({ operation_id: 2, status: "completed" }))
  this.retrieve = jest.fn(() => Promise.resolve([]))
  this.search = jest.fn(() => Promise.resolve([]))
  this.query = jest.fn(() => Promise.resolve({ points: [] }))
  this.scroll = jest.fn(() => Promise.resolve({ points: [], next_page_offset: undefined }))
  this.count = jest.fn(() => Promise.resolve({ count: 0 }))
  this.setPayload = jest.fn(() => Promise.resolve({ operation_id: 3, status: "completed" }))
  this.createPayloadIndex = jest.fn(() => Promise.resolve({ operation_id: 4, status: "completed" }))
  this.deletePayloadIndex = jest.fn(() => Promise.resolve({ operation_id: 5, status: "completed" }))
})

class QdrantClientConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "QdrantClientConfigError"
  }
}

class QdrantClientResourceExhaustedError extends Error {
  constructor(message) {
    super(message)
    this.name = "QdrantClientResourceExhaustedError"
  }
}

class QdrantClientTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = "QdrantClientTimeoutError"
  }
}

class QdrantClientUnexpectedResponseError extends Error {
  constructor(message) {
    super(message)
    this.name = "QdrantClientUnexpectedResponseError"
  }
}

module.exports = {
  __esModule: true,
  QdrantClient,
  QdrantClientConfigError,
  QdrantClientResourceExhaustedError,
  QdrantClientTimeoutError,
  QdrantClientUnexpectedResponseError,
}
