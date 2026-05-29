---
title: ADR-0004 — sqlite-vec 原生向量后端
description: 用真正基于 sqlite-vec 的实现替换无法工作的 NativeVectorStore 桩；让原生后端成为桌面端新用户的默认选项。
---

# sqlite-vec 原生向量后端

| 状态 | 已接受                                                                            |
| ---- | -------------------------------------------------------------------------------- |
| 日期 | 2026-05-02                                                                       |
| 取代 | `lib/vector/store.ts` 中无法工作的 `NativeVectorStore` 桩（commit 1）。           |

## 背景

cognia-next 提供了一个统一的 `IVectorStore` 接口（`lib/vector/store.ts`），声明了
六个提供方——`chroma`、`pinecone`、`qdrant`、`milvus`、`weaviate` 和 `native`。其中
五个提供方可用；第六个（`native`，即 Tauri 本地的「嵌入式」后端）无法工作：
`NativeVectorStore` 调用的 Tauri 命令（`vector_upsert_points`、`vector_search_points`
……）从未在 `src-tauri/src/lib.rs` 中注册。面向用户的 `VectorBackend` 设置类型
（`types/twin/index.ts:123`）明确省略了 `"native"`，因此这条损坏的路径在 UI 中
同样不可达。

于是 Twin 和 RAG 用户被迫在桌面上跑任何向量工作流之前，先搭建一个外部服务
（Qdrant、Pinecone、Chroma 服务器、Milvus 或 Weaviate）。这直接违背了桌面应用
对离线友好的价值主张——用户应当能够把文档摄取进自己的 Twin 并运行 RAG，而无需
任何外部基础设施。

本决策是一份包含四个 spec 的「superpowers」计划中的 **Spec A**：

- **A. 向量数据库加固** _（本 spec）_ —— 让原生后端变为可用；清理表面积。
- **B. 统一工具注册表 + MCP 暴露** _（暂缓）_ —— 工具的单一事实来源；通过独立的
  stdio MCP 服务器和应用内的 Streamable HTTP 服务器暴露它们。
- **C. Cognia 作为 ACP 服务器** _（暂缓）_ —— 反转协议方向，让外部编辑器
  （Zed、终端客户端）能够连接到 Cognia 内建的 agent。
- **D. 横切加固** _（暂缓）_ —— 认证令牌、权限闸、按连接的 allow-list；仅当其
  规模超出 B+C 自然衍生出的范围时才单独承接。

## 决策

### 1. sqlite-vec 作为原生向量存储引擎

我们用
[`sqlite-vec`](https://github.com/asg017/sqlite-vec) 实现原生后端，它是一个
通过虚拟表（`vec0`）为 SQLite 增加向量相似度搜索能力的扩展。数据库位于单个
文件：`<app_data>/cognia/vectors.sqlite` —— 与既有的
`scheduler_metadata.sqlite` 相邻。

带 `bundled` feature 的 `rusqlite 0.32` 已经是 scheduler 子系统的生产依赖；
唯一新增的 crate 条目只有 `sqlite-vec`。

### 2. IVectorStore 接口契约保持不变

既有的 `IVectorStore` 接口及其所有消费方（Twin 摄取、Twin 运行时、RAG 流水线、
chat hook）在原生后端上工作，除了在存储工厂的 switch 中加一个 `case "native"`
分支、以及对 `VectorBackend` 做一次类型放宽外，没有任何行为变化。消费方在设计上
就是后端无关的。

### 3. 十一个 Tauri 命令实现接口表面

Rust 模块 `src-tauri/src/vector/` 在 `src-tauri/src/lib.rs` 中注册了十一个命令：

```
vector_create_collection
vector_delete_collection
vector_list_collections
vector_get_collection
vector_upsert_points
vector_delete_points
vector_delete_all_points
vector_get_points
vector_search_points
vector_truncate_collection
vector_reset_store          (admin — "Reset vector store" button)
```

管理路径方法（`scrollDocuments`、`exportCollection`、`importCollection`、
`getStats`）暂缓；JS 侧的 `NativeVectorStore` 桩会抛出
`"not yet supported on native backend"`，这对一个可选的 `IVectorStore` 方法来说
是正确的行为。

### 4. 分数约定：`score = 1 − distance / 2`

`sqlite-vec` 的 `vec_distance_l2` 返回 L2 距离（越小越好）。统一接口使用
`score ∈ [0, 1]`（越大越好）。本项目中所有的 embedding 提供方都产出单位归一化的
向量（OpenAI、Cohere、Google、Mistral），因此恒等式 `score = 1 − distance / 2`
能让结果保持在 `[0, 1]` 内。该转换在 `db.rs` 中以内联注释记录。

### 5. 原生后端成为桌面端新用户的默认选项

`lib/db/twin-runtime-settings.ts` 的防御式合并层会为任何持久化设置中尚不含
`vectorBackend` 键的用户设置 `vectorBackend: isTauri() ? "native" : "qdrant"`。
既有用户保留其已配置的后端——不存在静默迁移。

### 6. Web 上隐藏设置 UI

Twin 设置标签页中的「Native (Tauri local)」单选项仅在 `isTauri()` 为真时才条件
渲染。`NativeVectorStore` 已经检查 `isTauri()`，并在 web 路径上抛出
`"Native vector store is only available in Tauri environment"`——这道护栏予以保留。

### 7. commit 5 移除死代码

`lib/ai/rag/rag.ts`（其唯一消费方就是它自己的测试）以及 `lib/vector/index.ts`
中带前缀的 re-export（`addChromaDocuments`、`queryQdrant` ……）被删除。
`lib/ai/rag/rag-tools.ts:14` 中引用不存在的 `agent-tools.ts` 的过时文档注释被修正。
净变化：移除约 400 LOC，新增约 600 LOC Rust、约 150 LOC TS。

## 数据模型

Rust 模块 `src-tauri/src/vector/` 遵循与 scheduler 子系统
（`src-tauri/src/scheduler/`）相同的分层结构：

| 文件          | 职责                                                                          |
| ------------- | --------------------------------------------------------------------------- |
| `mod.rs`      | 模块 barrel；re-export `VectorStore`、命令、公开类型。                       |
| `db.rs`       | `VectorStore { conn: Mutex<Connection> }`。打开/创建 `vectors.sqlite`，     |
|               | 加载 `sqlite_vec`，运行带版本的迁移。                                        |
| `schema.rs`   | 带版本的迁移：`migration_meta`、`collections`、`points` 表；                 |
|               | 按 collection 建立的 `vec_<id>` 虚拟表。                                     |
| `filters.rs`  | 纯函数：`(PayloadFilter[], mode) → (WHERE fragment, params)`。全部 14 个     |
|               | `FilterOperation` 变体均通过 SQL JSON1 `json_extract` 覆盖。                 |
| `commands.rs` | 匹配 `IVectorStore` 的十一个 Tauri 命令；对 `db.rs` 的薄封装。               |
| `types.rs`    | `Point`、`Collection`、`SearchHit`、`Filter`、`FilterOp`（serde）。          |
| `error.rs`    | `VectorError`（`thiserror`）+ `From<VectorError> for String`。              |

初始 schema（迁移 v1）：

```sql
-- tracking table
CREATE TABLE IF NOT EXISTS migration_meta (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

-- collection registry
CREATE TABLE IF NOT EXISTS collections (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
    dim                INTEGER NOT NULL,
    description        TEXT,
    embedding_model    TEXT,
    embedding_provider TEXT,
    metadata_json      TEXT,
    point_count        INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

-- dense points
CREATE TABLE IF NOT EXISTS points (
    rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    payload_json  TEXT,
    UNIQUE(collection_id, id)
);
```

按 collection 的向量表在 collection 创建时建立：

```sql
CREATE VIRTUAL TABLE vec_<id> USING vec0(embedding float[<dim>]);
```

每次连接打开时应用的 PRAGMA：`WAL`、`synchronous = NORMAL`、
`foreign_keys = ON`。

## 考虑过的备选方案

### 纯 Rust HNSW（`hnsw_rs`、`instant-distance`）

这些 crate 提供快速的近似最近邻搜索，但默认仅在内存中。还需要额外编写并维护一层
持久化（serde + 文件 I/O，或为图单独建一张 SQLite 表）。`sqlite-vec` 在单个存储
引擎中同时提供索引与持久化，而该引擎已经在我们的工具链中（`rusqlite 0.32 bundled`）。
否决。

### 捆绑 Qdrant sidecar

捆绑一个 Qdrant 二进制会显著增加安装包体积，并引入一个 sidecar 进程，其生命周期
（启动、崩溃恢复、版本升级）需要由应用自己负责。个人 twin 桌面工作流的预期规模
远低于 10 万 point——Qdrant 的水平扩展叙事在这里无关紧要，其单节点开销也不合理。
否决。

### LanceDB

LanceDB 是另一个带 Rust 内核的嵌入式向量数据库。它提供不同的存储范式（列式、
Arrow 原生），并有不断成长的 Rust 集成。然而它代表更大的依赖表面、更不成熟的
Rust API，以及与我们已为 `sqlite-vec` 设计的 SQL JSON1 过滤 DSL 根本不同的查询
模型。基于体量与成熟度的考量，否决。

## 后果

**正面**

- 原生后端成为真正的一等公民；Twin 在桌面上零配置开箱即用。核心用例无需任何
  外部服务。
- `IVectorStore` 抽象站得住脚：所有既有消费方无需修改即可工作。
- `lib/ai/rag/rag.ts` 中的死代码以及 `lib/vector/index.ts` 中带前缀的 re-export
  被移除，减小了表面积（commit 5）。
- 就绪性机制无需任何变更：`validateVectorConfig` 在 `isTauri()` 时已覆盖原生后端，
  且 `VectorBackendReadinessVerifier` 是通用工作的。

**取舍与风险**

- 新增 Rust 依赖：`sqlite-vec`。固定版本以匹配 `rusqlite 0.32`。若上游 API 变化，
  文档记录的兜底方案是通过 `unsafe extern "C"` 手动加载扩展——这是上游 README
  中一条久经验证的路径。
- 在 JSON1 元数据过滤上、不做惰性索引物化时，软上限约为 100 万 point。个人 twin
  规模（≤10 万 point）在 v1 中能舒适地处于该上限之下；`CREATE INDEX … json_extract(…)`
  的物化遍历是一项有文档记录的后续工作，取决于遥测数据。
- 跨进程并发假设：只有 Tauri 主进程写入 `vectors.sqlite`。多进程写竞争（例如两个
  运行中的 Tauri 实例指向同一数据目录）在 v1 中明确为 YAGNI，并记录在 spec 的
  §Concurrency 中。
- Windows 构建使用 `rusqlite bundled`——已由 scheduler 子系统验证；没有新的构建
  风险。

## 后续工作

以下事项明确暂缓，并在 spec 中跟踪：

1. **原生后端的管理方法对齐** —— `scrollDocuments`、`exportCollection`、
   `importCollection`、`getStats`、`countDocuments`、`renameCollection`。它们目前
   在原生后端上抛出 `"not yet supported"`。一份小型后续 spec 将增加这些 Tauri
   命令及 JS 接线。

2. **惰性元数据索引物化** —— 为频繁过滤的字段做 `CREATE INDEX … json_extract(…)`。
   暂缓；取决于针对真实 Twin 数据集测量尾部延迟。

3. **向量工具作为进程内 agent 工具** —— 将 `vector_search`、`vector_add_document`
   等注册为可在会话中使用的 agent 工具。见 Spec B。

4. **以 ACP 暴露 Cognia 内建 agent** —— 反转协议方向，让外部编辑器能连接到
   Cognia。见 Spec C。

## 参见

- `src-tauri/src/vector/db.rs` —— VectorStore 结构体、schema 引导、sqlite-vec 集成
- `src-tauri/src/vector/filters.rs` —— SQL 过滤构建器（全部 14 个 `FilterOperation` 操作）
- `src-tauri/src/vector/commands.rs` —— 十一个 Tauri 命令
- `lib/vector/store.ts` —— `NativeVectorStore` JS 实现
- `types/twin/index.ts` —— `VectorBackend` 类型（放宽以包含 `"native"`）
- `lib/db/twin-runtime-settings.ts` —— 防御式默认值：`isTauri()` 时为 `"native"`
- `components/twin/twin-settings-tab.tsx` —— 设置 UI（原生单选项 + 重置按钮）
- `docs/superpowers/specs/2026-05-02-vector-db-hardening-design.md` —— 完整 Spec A
