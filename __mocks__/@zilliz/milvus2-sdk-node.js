/**
 * Manual Jest mock for `@zilliz/milvus2-sdk-node`.
 *
 * The real package is Node-only (gRPC + thrift + tls) and can't run in the
 * jsdom test environment. The existing tests (`lib/vector/milvus-client.test.ts`)
 * exercise the higher-level helpers in `lib/vector/milvus-client.ts` end-to-end:
 * they create a collection, upsert points, query / search, etc. So this
 * mock keeps a small in-memory state map (collections + their points) so
 * the surface behaves the way tests expect — `hasCollection` returns true
 * after `createCollection`, etc.
 *
 * The mock exposes a `resetMockState()` helper (consumed by the tests via
 * `jest.requireMock(...)`) to clear the state between describes.
 */

let collections = new Map() // name → { dim, points: Map<id, point>, partitions: Set<string> }

function ensureCollection(name) {
  if (!collections.has(name)) {
    collections.set(name, {
      dim: 0,
      points: new Map(),
      partitions: new Set(["_default"]),
    })
  }
  return collections.get(name)
}

class MilvusClient {
  constructor(_config) {
    // Tests assert against the higher-level helpers, not the constructor
    // arguments, so we accept anything and store nothing.
  }

  closeConnection() {
    // No-op — there's no socket to tear down in the in-memory mock.
  }

  async hasCollection({ collection_name }) {
    return { value: collections.has(collection_name) }
  }

  async createCollection({ collection_name, fields }) {
    const dim = (() => {
      const vec = fields?.find((f) => f.data_type === 101 || f.data_type === "FloatVector")
      const dimParam = vec?.type_params?.find((p) => p.key === "dim")
      return dimParam ? Number(dimParam.value) : 0
    })()
    const c = ensureCollection(collection_name)
    c.dim = dim || c.dim
    return { error_code: "Success", reason: "" }
  }

  async dropCollection({ collection_name }) {
    collections.delete(collection_name)
    return { error_code: "Success", reason: "" }
  }

  async listCollections() {
    return {
      data: Array.from(collections.keys()).map((name) => ({ name })),
      status: { error_code: "Success", reason: "" },
    }
  }

  async describeCollection({ collection_name }) {
    const c = collections.get(collection_name)
    if (!c) {
      return {
        status: { error_code: "CollectionNotExists", reason: "collection not found" },
        schema: { description: "", fields: [] },
      }
    }
    return {
      status: { error_code: "Success", reason: "" },
      schema: {
        description: "",
        fields: [
          {
            name: "id",
            data_type: 21, // VarChar
            is_primary_key: true,
            type_params: [{ key: "max_length", value: "256" }],
          },
          {
            name: "content",
            data_type: 21,
            type_params: [{ key: "max_length", value: "65535" }],
          },
          {
            name: "vector",
            data_type: 101, // FloatVector
            type_params: [{ key: "dim", value: String(c.dim || 0) }],
          },
        ],
      },
    }
  }

  async getCollectionStatistics({ collection_name }) {
    const c = collections.get(collection_name)
    return {
      status: { error_code: "Success", reason: "" },
      stats: [{ key: "row_count", value: String(c?.points.size ?? 0) }],
    }
  }

  async describeIndex({ collection_name: _name, field_name: _field }) {
    return {
      status: { error_code: "Success", reason: "" },
      index_descriptions: [
        {
          field_name: "vector",
          index_name: "vector_index",
          indexID: "1",
          params: [
            { key: "index_type", value: "HNSW" },
            { key: "metric_type", value: "COSINE" },
          ],
        },
      ],
    }
  }

  async createIndex({ collection_name: _name, field_name: _field }) {
    return { error_code: "Success", reason: "" }
  }

  async dropIndex({ collection_name: _name, field_name: _field }) {
    return { error_code: "Success", reason: "" }
  }

  async loadCollection({ collection_name }) {
    ensureCollection(collection_name)
    return { error_code: "Success", reason: "" }
  }

  async releaseCollection({ collection_name: _name }) {
    return { error_code: "Success", reason: "" }
  }

  async flush({ collection_names: _names }) {
    return { status: { error_code: "Success", reason: "" } }
  }

  async getLoadingProgress({ collection_name }) {
    return {
      status: { error_code: "Success", reason: "" },
      progress: collections.has(collection_name) ? "100" : "0",
    }
  }

  async compact({ collection_name: _name }) {
    return { status: { error_code: "Success", reason: "" }, compactionID: "1" }
  }

  async createPartition({ collection_name, partition_name }) {
    const c = ensureCollection(collection_name)
    c.partitions.add(partition_name)
    return { error_code: "Success", reason: "" }
  }

  async dropPartition({ collection_name, partition_name }) {
    const c = collections.get(collection_name)
    if (c) c.partitions.delete(partition_name)
    return { error_code: "Success", reason: "" }
  }

  async listPartitions({ collection_name }) {
    const c = collections.get(collection_name)
    return {
      status: { error_code: "Success", reason: "" },
      partition_names: c ? Array.from(c.partitions) : [],
    }
  }

  async upsert({ collection_name, data }) {
    const c = ensureCollection(collection_name)
    for (const row of data || []) {
      if (row && row.id !== undefined && row.id !== null) {
        c.points.set(String(row.id), { ...row })
      }
    }
    return {
      status: { error_code: "Success", reason: "" },
      IDs: { int_id: { data: [] }, str_id: { data: (data || []).map((d) => String(d.id)) } },
      succ_index: (data || []).map((_, i) => i),
      err_index: [],
      acknowledged: true,
      insert_cnt: data?.length ?? 0,
      delete_cnt: 0,
      upsert_cnt: data?.length ?? 0,
      timestamp: String(Date.now()),
    }
  }

  async insert(args) {
    return this.upsert(args)
  }

  async delete({ collection_name, filter }) {
    const c = collections.get(collection_name)
    if (c && filter) {
      // Match `id in ["a", "b"]` style filter — the helpers in milvus-client.ts
      // emit exactly that shape for delete-by-IDs.
      const m = /id\s+in\s+\[(.+)\]/i.exec(filter)
      if (m) {
        const ids = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""))
        for (const id of ids) c.points.delete(id)
      }
    }
    return {
      status: { error_code: "Success", reason: "" },
      IDs: { int_id: { data: [] }, str_id: { data: [] } },
      delete_cnt: 0,
    }
  }

  async search({ collection_name, limit }) {
    const c = collections.get(collection_name)
    if (!c) {
      return { status: { error_code: "Success", reason: "" }, results: [] }
    }
    const results = Array.from(c.points.values())
      .slice(0, limit ?? 5)
      .map((p, i) => ({
        ...p,
        id: p.id,
        score: 1 - i * 0.01,
      }))
    return { status: { error_code: "Success", reason: "" }, results }
  }

  async query({ collection_name, output_fields }) {
    const c = collections.get(collection_name)
    if (!c) return { status: { error_code: "Success", reason: "" }, data: [] }

    // Handle the count(*) special case used by `countMilvusDocuments`.
    if (output_fields && output_fields.includes("count(*)")) {
      return {
        status: { error_code: "Success", reason: "" },
        data: [{ "count(*)": c.points.size }],
      }
    }

    return {
      status: { error_code: "Success", reason: "" },
      data: Array.from(c.points.values()),
    }
  }

  async hybridSearch({ collection_name, limit }) {
    const c = collections.get(collection_name)
    if (!c) return { status: { error_code: "Success", reason: "" }, results: [] }
    const results = Array.from(c.points.values())
      .slice(0, limit ?? 5)
      .map((p, i) => ({ ...p, id: p.id, score: 1 - i * 0.01 }))
    return { status: { error_code: "Success", reason: "" }, results }
  }
}

class CloudClient extends MilvusClient {}

const DataType = {
  None: 0,
  Bool: 1,
  Int8: 2,
  Int16: 3,
  Int32: 4,
  Int64: 5,
  Float: 10,
  Double: 11,
  String: 20,
  VarChar: 21,
  Array: 22,
  JSON: 23,
  BinaryVector: 100,
  FloatVector: 101,
  Float16Vector: 102,
  BFloat16Vector: 103,
  SparseFloatVector: 104,
}

const MetricType = {
  L2: "L2",
  IP: "IP",
  COSINE: "COSINE",
  HAMMING: "HAMMING",
  JACCARD: "JACCARD",
}

const ConsistencyLevelEnum = {
  Strong: "Strong",
  Session: "Session",
  Bounded: "Bounded",
  Eventually: "Eventually",
  Customized: "Customized",
}

const IndexType = {
  FLAT: "FLAT",
  IVF_FLAT: "IVF_FLAT",
  IVF_SQ8: "IVF_SQ8",
  IVF_PQ: "IVF_PQ",
  HNSW: "HNSW",
  AUTOINDEX: "AUTOINDEX",
}

function resetMockState() {
  collections = new Map()
}

module.exports = {
  __esModule: true,
  MilvusClient,
  CloudClient,
  DataType,
  MetricType,
  ConsistencyLevelEnum,
  IndexType,
  resetMockState,
}
