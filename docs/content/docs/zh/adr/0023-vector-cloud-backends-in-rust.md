---
title: "ADR-0023 — Rust 中的向量云后端"
---

# ADR-0023 — Rust 中的向量云后端

已接受 — 2026-05-17。

# 背景

迁移前，`lib/vector/store.ts`发布了五个云向量 提供商（Chroma、Pinecone、Qdrant、Milvus、Weaviate）TypeScript实现，每个实现都导入上游 npm SDK并在 Tauri webview 中实例化。五个SDKs（`@pinecone-database/pinecone`、`@qdrant/js-client-rest`、`chromadb`、`@zilliz/milvus2-sdk-node`、`weaviate-client`）及其 gRPC / Parquet 传递依赖被通过 `next.config.ts` 混叠成空存根，以保持静态导出捆包的干净。意外后果：在生产环境中选择任何云端 提供商 在 运行时 失败——`new ChromaClient()` 解决了反对`module.exports = {}`并抛弃了`... is not a constructor`。

云路径实际上是死代码：已发货，包含在`package.json`中，在设置UI中浮现，但无法执行。

# 决策

将五个云后端实现从TypeScript移植到Rust `src-tauri/src/vector/backends/`。使用一个共享异步特征（`VectorBackend`），使每个后端暴露相同的操作接口;通过由OS-keyring-stored 凭证懒散构建的per-`configId` `Arc<dyn VectorBackend>`缓存（`VectorRegistry`）调度。

原生 sqlite-vec 后端继续使用现有`VectorState`/`vector_*` 命令 接口——在本迭代中通过异步特性运行现有的同步 sqlite 路径没有功能性益处。

# 建筑

```
TypeScript                        |  Rust
                                  |
CloudVectorStore (shared)         |  VectorRegistry
  ├ ChromaVectorStore             |    └ resolve(provider, configId)
  ├ PineconeVectorStore           |         ↓
  ├ QdrantVectorStore             |    Arc<dyn VectorBackend>
  ├ MilvusVectorStore             |         ├ PineconeBackend (reqwest)
  └ WeaviateVectorStore           |         ├ QdrantBackend (qdrant-client)
        │                         |         ├ ChromaBackend  (reqwest)
        ▼                         |         ├ MilvusBackend  (reqwest)
   vectorCloudInvoke              |         └ WeaviateBackend(reqwest)
        │                         |
        ▼ Tauri invoke()          |  credentials::{save, load, delete}
   vector_cloud_*                 |         ↓
                                  |  keyring_secrets   (OS keyring)
                                  |  com.cognia.vector.<provider>/v1
                                  |    account = configId
                                  |    value   = JSON(VectorCredentials)
```

## 组件分解

- **`VectorBackend`特征**（`src-tauri/src/vector/backend.rs`）：12种异步方法——`create_collection`、`delete_collection`、`list_collections`、`get_collection`、`upsert`、`delete_points`、`get_points`、`truncate`、`query`、`scroll`、`count`、`health_check`。

- **`VectorRegistry`**（`src-tauri/src/vector/registry.rs`）：`RwLock<HashMap<String, Arc<dyn VectorBackend>>>`由`configId`键化。`resolve()`懒惰地从密钥环读取凭证，并在首次访问时实例化后端。`provider = "native"`是已拒绝——原生的SQLite路径保持在`VectorState`。

- **凭证**（`src-tauri/src/vector/credentials.rs`）：标签联合`VectorCredentials`（每个云端提供商一个变体），序列化为JSON，存储在OS 密钥环中命名空间`vector.<provider>`由`configId`键控。封装现有`crate::keyring_secrets`模块。

- **Tauri 命令 接口**（`src-tauri/src/vector/commands.rs`）：14个新`vector_cloud_*` 命令。所有跨提供商 命令都采用`(provider, configId)`加运算参数。命名是有意避免与17个遗留本地`vector_*` 命令碰撞，因此推送在Rust端纯粹是加法。

- **TS 调用层**（`lib/vector/invoke.ts`）：每个命令有类型封装器（`vectorCloudInvoke.*`）。线形使用snake_case（匹配 Serde 默认Rust）;TS调用者将camelCase传递给该模块，封装器进行翻译。

- **TS云存储**（`lib/vector/store.ts`）：一个`CloudVectorStore`基础类+5个三行子类。基础拥有Rust特质不处理的跨界JS-side：
  - 嵌入生成（直接调用OpenAI/Google/Cohere/Mistral）
  - `applyUnifiedPostFilters`对于提供商无关子串/空算子，Rust翻译器会被删除
  - `applyThresholdAndPagination` 用于分数截止 + 偏移切片

## 权衡

| 相位 | 迁徙前 | 迁徙后 |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------- |
| 云提供商 运行时 | 已死（SDKs别名为`{}`） | Real（Rust HTTP/gRPC） |
| 束重 | 服务器端重型 DEPS 已发货+混淆 | 5 SDKs + grpc/parquet 传递式被移除 |
| 凭证 | IndexedDB明文（Zustand 持续存在） | OS 密钥环，由`configId`发言 |
| 滤波器表现力 | 所有运营部门每人处理JS-side 提供商 | Rust中的比较操作，substring/null JS后滤波器中的操作 |
| Web/SSR部署 | 云破碎（别名小作品） | 云不可用（网页无Tauri 命令） |

web/SSR损失是可以接受的：该项目目前仅为云向量应用场景提供Tauri。

## 提供商专属音符

- **松果** — REST对抗`https://api.pinecone.io/indexes`控制平面，懒惰缓存主机用于数据平面（`/vectors/upsert`、`/query`、`/vectors/delete`、`/describe_index_stats`）。
- **Qdrant** — 官方`qdrant-client = "1.18"` crate，gRPC模式。端口6334是默认gRPC端口;用户必须相应配置URLs。
- **色度**——REST对`/api/v1/collections/*`;`create_collection`用`get_or_create: true`表示幂等性。
- **Milvus** — 故意使用HTTP `/v2/vectordb/*` API而非`milvus-sdk-rust 0.1.0`。SDK已确认损坏（`build-script-build`在本地`protoc`安装时会慌张）。HTTP路径使Milvus与其他reqwest后端保持一致。
- **Weaviate** — Oracle REST for schema （`/v1/schema`） + batch upsert （`/v1/batch/objects`）， GraphQL for query （`/v1/graphql`）。

## 迁移路径

一次性启动hook（`lib/vector/migrations/credential-migration.ts`）读取pre-ADR-0023 Zustand持久化的blob，将明文凭证写入`migrated-<provider>` configIds下的密钥环，从localStorage中剥离明文字段，并设置`vector-credentials-migrated`标志。幂零——第二次运行为无操作。

现有用户不会看到功能变化;他们的云配置在升级后首次发布时就透明地实现了密钥环支持。

# 后果

**阳性：**

- 云端提供商选择现在在Tauri生产构建中实际上有效。
- 丛收缩（5 npm 的SDKs + 去除其gRPC/Parquet传递）。
- 凭证不再只是明文IndexedDB。
- 通过实现单一特性即可添加新的云端提供商，除了凭证变体外，没有JS-side更改。

**负面/推迟：**

- Web/SSR部署同一个Next.js应用会失去云向量支持。可接受——Tauri是主要接口。
- 8个高级原生命令（`export_collection`、`import_collection`、`rename_collection`、`truncate_collection`、`delete_all_points`、`get_stats`、`reset_store`、`get_store_size`）仍保持原生。如果云端对应物变得有用，未来PR将它们加入该特质。
- 滤波器操作时，Rust翻译器会丢弃（子字符串/空检查在Pinecone/Qdrant;`in/not_in`在Milvus/Weaviate）回退到JS滤波器后。对于非常大的结果集，这意味着会进行过取。

# 受影响的模块

- 新 Rust：`vector/{backend,credentials,registry,backends/*}.rs`
- 修改Rust：`vector/{types,commands,mod,error}.rs`、`lib.rs`（处理器注册、州管理）、`keyring_secrets.rs`（有线接入 lib.rs）
- 新TS：`lib/vector/invoke.ts`，`lib/vector/migrations/`
- 重写版TS：`lib/vector/store.ts`（2582 → 1400行）
- 修改后TS：`lib/vector/readiness.ts`、`lib/plugin/api/vector-api.ts`、`lib/ai/rag/{citation-formatter,context-manager}.ts`、`stores/vector/vector-store.ts`
- 已删除TS：`lib/vector/{chroma,pinecone,qdrant,milvus,weaviate}-client.ts`（+ 测试，~4700行）
- 配置：移除`next.config.ts` SDK个别名;移除`package.json` SDK依赖。

# 验证

- `cargo check --no-default-features`：0个错误。
- `cargo test --lib vector::*`：24 次测试（过滤翻译器、凭证 serde、注册表、wiremock 模拟HTTP后端）。_Note_：Windows 主机的测试可执行文件当前无法加载（这是之前存在的 0xc0000139 DLL 问题，与本次迁移无关）。
- `pnpm typecheck`：干净（6个已有的`components/settings/companion/webrtc-card.test.tsx`错误是无关的进行中）。
- `pnpm test -- lib/vector/`：向量模块测试通过。
- `pnpm build`：成功。捆集检查确认没有`PineconeClient`/`ChromaClient`/`MilvusClient`类符号泄漏到`out/_next/static/chunks/`。
