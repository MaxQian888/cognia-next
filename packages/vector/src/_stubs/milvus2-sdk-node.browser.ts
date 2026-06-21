/**
 * Browser-side stub for `@zilliz/milvus2-sdk-node`.
 *
 * The real package depends on `@grpc/grpc-js`, `tls`, `dns`, `http2`,
 * `thrift`, etc. — all Node-only modules. Tauri runs the Next.js bundle
 * inside a webview (a browser), so the real package can never load there.
 *
 * Turbopack is configured (in `next.config.ts`) to alias the package to
 * this file for the browser build, so the bundle compiles. At runtime, if
 * a user picks "milvus" as their vector backend in the browser/Tauri
 * webview, the constructor throws a clear error explaining the limitation.
 *
 * Server / Node test runs continue to use the real package — Jest does not
 * read Turbopack's resolveAlias.
 */

const NOT_SUPPORTED =
  "Milvus is not supported in the browser/Tauri webview runtime. " +
  "@zilliz/milvus2-sdk-node uses Node-only gRPC; pick another vector " +
  "backend (Pinecone, Qdrant, Weaviate, Chroma, or Native sqlite-vec)."

export class MilvusClient {
  constructor(..._args: unknown[]) {
    throw new Error(NOT_SUPPORTED)
  }
}

export class CloudClient extends MilvusClient {}

export enum DataType {
  None = 0,
  Bool = 1,
  Int8 = 2,
  Int16 = 3,
  Int32 = 4,
  Int64 = 5,
  Float = 10,
  Double = 11,
  String = 20,
  VarChar = 21,
  Array = 22,
  JSON = 23,
  BinaryVector = 100,
  FloatVector = 101,
  Float16Vector = 102,
  BFloat16Vector = 103,
  SparseFloatVector = 104,
}

export enum MetricType {
  L2 = "L2",
  IP = "IP",
  COSINE = "COSINE",
  HAMMING = "HAMMING",
  JACCARD = "JACCARD",
}

export enum ConsistencyLevelEnum {
  Strong = "Strong",
  Session = "Session",
  Bounded = "Bounded",
  Eventually = "Eventually",
  Customized = "Customized",
}

export enum IndexType {
  FLAT = "FLAT",
  IVF_FLAT = "IVF_FLAT",
  IVF_SQ8 = "IVF_SQ8",
  IVF_PQ = "IVF_PQ",
  HNSW = "HNSW",
  AUTOINDEX = "AUTOINDEX",
}

export const VectorDataTypes: DataType[] = [
  DataType.BinaryVector,
  DataType.FloatVector,
  DataType.Float16Vector,
  DataType.BFloat16Vector,
  DataType.SparseFloatVector,
]

const milvusBrowserStub = {
  MilvusClient,
  CloudClient,
  DataType,
  MetricType,
  ConsistencyLevelEnum,
  IndexType,
}
export default milvusBrowserStub
