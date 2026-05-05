import milvusDefault, {
  CloudClient,
  ConsistencyLevelEnum,
  DataType,
  IndexType,
  MetricType,
  MilvusClient,
  VectorDataTypes,
} from "./milvus2-sdk-node.browser"

describe("lib/vector/_stubs/milvus2-sdk-node.browser", () => {
  test("MilvusClient constructor throws with the expected guidance", () => {
    expect(() => new MilvusClient()).toThrow(/Milvus is not supported in the browser/)
    expect(() => new MilvusClient({ address: "anything" })).toThrow(/Pinecone, Qdrant/)
  })

  test("CloudClient inherits the same throwing constructor", () => {
    expect(() => new CloudClient()).toThrow(/Milvus is not supported/)
  })

  test("DataType enum exposes the literal values the real SDK ships", () => {
    expect(DataType.FloatVector).toBe(101)
    expect(DataType.SparseFloatVector).toBe(104)
    expect(DataType.None).toBe(0)
  })

  test("MetricType / ConsistencyLevelEnum / IndexType are string enums", () => {
    expect(MetricType.COSINE).toBe("COSINE")
    expect(ConsistencyLevelEnum.Strong).toBe("Strong")
    expect(IndexType.HNSW).toBe("HNSW")
  })

  test("VectorDataTypes lists every vector-shaped DataType", () => {
    expect(VectorDataTypes).toEqual(
      expect.arrayContaining([
        DataType.BinaryVector,
        DataType.FloatVector,
        DataType.Float16Vector,
        DataType.BFloat16Vector,
        DataType.SparseFloatVector,
      ])
    )
    expect(VectorDataTypes).toHaveLength(5)
  })

  test("default export bundles the same surface", () => {
    expect(milvusDefault.MilvusClient).toBe(MilvusClient)
    expect(milvusDefault.CloudClient).toBe(CloudClient)
    expect(milvusDefault.DataType).toBe(DataType)
    expect(milvusDefault.MetricType).toBe(MetricType)
    expect(milvusDefault.ConsistencyLevelEnum).toBe(ConsistencyLevelEnum)
    expect(milvusDefault.IndexType).toBe(IndexType)
  })
})
