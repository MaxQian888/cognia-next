/**
 * Mock vector DB endpoint covering the four cloud providers the repo
 * currently supports — Pinecone, Qdrant, Chroma, Milvus — through a single
 * Express app that emulates the surface each SDK calls during embedding,
 * upsert, and query operations.
 *
 * The twin/RAG, plugin, and AI nodes never own this server; specs that
 * exercise vector search point the configured vector-store baseUrl here
 * (via the dev-only credential override exposed in expose-test-globals).
 *
 * Implements:
 *   - POST /upsert       — generic upsert (Pinecone-shaped)
 *   - POST /query        — generic query (top-k matches)
 *   - GET  /collections  — Qdrant-style collection listing
 *   - PUT  /collections/:name — Qdrant-style create
 *   - POST /collections/:name/points/upsert — Qdrant points upsert
 *   - POST /collections/:name/points/search — Qdrant search
 *   - POST /api/v1/collections — Chroma create
 *   - POST /api/v1/collections/:id/add — Chroma add
 *   - POST /api/v1/collections/:id/query — Chroma query
 *   - POST /v2/vectordb/entities/search — Milvus search
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createExpressApp = () => require("express")() as import("express").Application

import type { Server } from "http"

export interface VectorPoint {
  id: string | number
  vector: number[]
  metadata?: Record<string, unknown>
}

export interface MockVectorDbServer {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string

  /** Seed a collection with points so /query / /search return them. */
  seedCollection(name: string, points: VectorPoint[]): void
  /** All upsert / add calls captured (across providers). */
  readonly upserts: Array<{ collection: string; points: VectorPoint[] }>
  /** All query / search calls captured. */
  readonly queries: Array<{ collection: string; vector?: number[]; topK?: number }>
  reset(): void
}

export function createMockVectorDbServer(): MockVectorDbServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express")
  app.use(express.json({ limit: "8mb" }))

  let server: Server | null = null
  let _port = 0
  const collections = new Map<string, VectorPoint[]>()
  const upserts: Array<{ collection: string; points: VectorPoint[] }> = []
  const queries: Array<{ collection: string; vector?: number[]; topK?: number }> = []

  // ── Pinecone-style ───────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/upsert", (req: any, res: any) => {
    const body = req.body as {
      namespace?: string
      vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>
    }
    const points: VectorPoint[] = body.vectors.map((v) => ({
      id: v.id,
      vector: v.values,
      metadata: v.metadata,
    }))
    const col = body.namespace ?? "default"
    upserts.push({ collection: col, points })
    const existing = collections.get(col) ?? []
    collections.set(col, [...existing, ...points])
    res.json({ upsertedCount: points.length })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/query", (req: any, res: any) => {
    const body = req.body as { namespace?: string; vector: number[]; topK?: number }
    queries.push({ collection: body.namespace ?? "default", vector: body.vector, topK: body.topK })
    const col = collections.get(body.namespace ?? "default") ?? []
    const k = body.topK ?? 3
    res.json({
      matches: col.slice(0, k).map((p, i) => ({
        id: String(p.id),
        score: 1 - i * 0.05,
        values: p.vector,
        metadata: p.metadata ?? {},
      })),
    })
  })

  // ── Qdrant-style ─────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get("/collections", (_req: any, res: any) => {
    res.json({ result: { collections: [...collections.keys()].map((name) => ({ name })) } })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.put("/collections/:name", (req: any, res: any) => {
    collections.set(req.params.name, collections.get(req.params.name) ?? [])
    res.json({ result: true, status: "ok" })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/collections/:name/points/upsert", (req: any, res: any) => {
    const body = req.body as {
      points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }>
    }
    const points: VectorPoint[] = body.points.map((p) => ({
      id: p.id,
      vector: p.vector,
      metadata: p.payload,
    }))
    upserts.push({ collection: req.params.name, points })
    collections.set(req.params.name, [...(collections.get(req.params.name) ?? []), ...points])
    res.json({ result: { operation_id: upserts.length, status: "acknowledged" } })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/collections/:name/points/search", (req: any, res: any) => {
    const body = req.body as { vector: number[]; limit?: number }
    queries.push({ collection: req.params.name, vector: body.vector, topK: body.limit })
    const col = collections.get(req.params.name) ?? []
    const limit = body.limit ?? 3
    res.json({
      result: col.slice(0, limit).map((p, i) => ({
        id: p.id,
        score: 1 - i * 0.05,
        payload: p.metadata ?? {},
        vector: p.vector,
      })),
    })
  })

  // ── Chroma-style ─────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/api/v1/collections", (req: any, res: any) => {
    const body = req.body as { name: string }
    collections.set(body.name, collections.get(body.name) ?? [])
    res.json({ id: body.name, name: body.name })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/api/v1/collections/:id/add", (req: any, res: any) => {
    const body = req.body as {
      ids: string[]
      embeddings: number[][]
      metadatas?: Array<Record<string, unknown>>
    }
    const points: VectorPoint[] = body.ids.map((id, i) => ({
      id,
      vector: body.embeddings[i],
      metadata: body.metadatas?.[i],
    }))
    upserts.push({ collection: req.params.id, points })
    collections.set(req.params.id, [...(collections.get(req.params.id) ?? []), ...points])
    res.json({ success: true })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/api/v1/collections/:id/query", (req: any, res: any) => {
    const body = req.body as { query_embeddings: number[][]; n_results?: number }
    queries.push({
      collection: req.params.id,
      vector: body.query_embeddings[0],
      topK: body.n_results,
    })
    const col = collections.get(req.params.id) ?? []
    const n = body.n_results ?? 3
    res.json({
      ids: [col.slice(0, n).map((p) => String(p.id))],
      distances: [col.slice(0, n).map((_, i) => i * 0.05)],
      metadatas: [col.slice(0, n).map((p) => p.metadata ?? {})],
      embeddings: null,
    })
  })

  // ── Milvus-style ─────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/v2/vectordb/entities/search", (req: any, res: any) => {
    const body = req.body as { collectionName: string; vector: number[]; topK?: number }
    queries.push({ collection: body.collectionName, vector: body.vector, topK: body.topK })
    const col = collections.get(body.collectionName) ?? []
    const k = body.topK ?? 3
    res.json({
      code: 0,
      data: col.slice(0, k).map((p, i) => ({ id: p.id, distance: i * 0.05, ...p.metadata })),
    })
  })

  return {
    async start(port = 0): Promise<void> {
      await new Promise<void>((resolve) => {
        server = app.listen(port, () => {
          const addr = server!.address()
          _port = typeof addr === "object" && addr ? addr.port : port
          resolve()
        })
      })
    },
    async stop(): Promise<void> {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()))
      })
      server = null
    },
    get port() {
      return _port
    },
    get baseUrl() {
      return `http://127.0.0.1:${_port}`
    },
    seedCollection(name, points) {
      collections.set(name, points.slice())
    },
    get upserts() {
      return upserts
    },
    get queries() {
      return queries
    },
    reset() {
      collections.clear()
      upserts.length = 0
      queries.length = 0
    },
  }
}
