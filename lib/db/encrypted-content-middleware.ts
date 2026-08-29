import Dexie, {
  type DBCore,
  type DBCoreCursor,
  type DBCoreMutateRequest,
  type DBCoreTable,
  type Middleware,
} from "dexie"

import {
  getActiveAccountContentCipher,
  type EncryptedContentEnvelope,
} from "@/lib/accounts/content-cipher"
import { policyForTable } from "@/lib/data-governance/table-catalog"

export const CONTENT_ENCRYPTION_SCHEMA_VERSION = 1
export const ENCRYPTED_CONTENT_FIELD = "__cogniaEncryptedContent"

type StoredEncryptedRow = Record<string, unknown> & {
  [ENCRYPTED_CONTENT_FIELD]: EncryptedContentEnvelope
}

export function createEncryptedContentMiddleware(databaseName: string): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "AccountEncryptedContentMiddleware",
    level: 2,
    create: (down) => ({
      ...down,
      table: (tableName) => {
        const table = down.table(tableName)
        if (policyForTable(tableName)?.contentProtection !== "encrypted-content") return table
        return encryptedTable(databaseName, table)
      },
    }),
  }
}

function encryptedTable(databaseName: string, table: DBCoreTable): DBCoreTable {
  const indexedRoots = indexedPropertyRoots(table)
  const cipher = () => {
    const active = getActiveAccountContentCipher(databaseName)
    if (!active) throw new Error(`Account content cipher is locked for ${databaseName}.`)
    return active
  }

  const decryptRow = async (row: unknown, explicitKey?: unknown): Promise<unknown> => {
    if (!isRecord(row)) return row
    const envelope = row[ENCRYPTED_CONTENT_FIELD]
    if (!isEncryptedEnvelope(envelope)) return row
    const primaryKey = explicitKey ?? table.schema.primaryKey.extractKey?.(row)
    const payload = await cipher().decrypt<Record<string, unknown>>(
      table.name,
      primaryKey,
      "payload",
      CONTENT_ENCRYPTION_SCHEMA_VERSION,
      envelope
    )
    const metadata = { ...row }
    delete metadata[ENCRYPTED_CONTENT_FIELD]
    return { ...metadata, ...payload }
  }

  const encryptRow = async (row: unknown, explicitKey?: unknown): Promise<unknown> => {
    if (!isRecord(row)) return row
    const primaryKey = explicitKey ?? table.schema.primaryKey.extractKey?.(row)
    if (primaryKey === undefined || primaryKey === null) {
      throw new Error(`Encrypted table ${table.name} requires a primary key before persistence.`)
    }
    const metadata: Record<string, unknown> = {}
    const payload: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(row)) {
      if (field === ENCRYPTED_CONTENT_FIELD) continue
      if (indexedRoots.has(field) || isQueryableMetadataField(field)) metadata[field] = value
      else payload[field] = value
    }
    metadata[ENCRYPTED_CONTENT_FIELD] = await cipher().encrypt(
      table.name,
      primaryKey,
      "payload",
      CONTENT_ENCRYPTION_SCHEMA_VERSION,
      payload
    )
    return metadata as StoredEncryptedRow
  }

  return {
    ...table,
    async mutate(request: DBCoreMutateRequest) {
      cipher()
      if (request.type !== "add" && request.type !== "put") return table.mutate(request)
      if (request.values.length === 0) {
        throw new Error(`Encrypted table ${table.name} does not allow criteria-only mutations.`)
      }
      const values = await Dexie.waitFor(
        Promise.all(request.values.map((value, index) => encryptRow(value, request.keys?.[index])))
      )
      return table.mutate({ ...request, values })
    },
    async get(request) {
      cipher()
      return decryptRow(await table.get(request), request.key)
    },
    async getMany(request) {
      cipher()
      const rows = await table.getMany(request)
      return Promise.all(rows.map((row, index) => decryptRow(row, request.keys[index])))
    },
    async query(request) {
      cipher()
      const response = await table.query(request)
      if (request.values === false) return response
      return {
        ...response,
        result: await Promise.all(response.result.map((row) => decryptRow(row))),
      }
    },
    async openCursor(request) {
      cipher()
      const cursor = await table.openCursor(request)
      return cursor ? wrapCursor(cursor, decryptRow) : null
    },
    count(request) {
      cipher()
      return table.count(request)
    },
  }
}

function wrapCursor(
  cursor: DBCoreCursor,
  decryptRow: (row: unknown, explicitKey?: unknown) => Promise<unknown>
): DBCoreCursor {
  let currentValue: unknown
  const wrapper: DBCoreCursor = Object.create(cursor, {
    value: { get: () => currentValue },
    key: { get: () => cursor.key },
    primaryKey: { get: () => cursor.primaryKey },
    done: { get: () => cursor.done },
    trans: { get: () => cursor.trans },
    continue: { value: (key?: unknown) => cursor.continue(key) },
    continuePrimaryKey: {
      value: (key: unknown, primaryKey: unknown) => cursor.continuePrimaryKey(key, primaryKey),
    },
    advance: { value: (count: number) => cursor.advance(count) },
    stop: { value: (value?: unknown) => cursor.stop(value) },
    fail: { value: (error: Error) => cursor.fail(error) },
    start: {
      value: (callback: () => void) =>
        cursor.start(() => {
          void Dexie.waitFor(decryptRow(cursor.value, cursor.primaryKey)).then(
            (value) => {
              currentValue = value
              callback()
            },
            (error: unknown) =>
              cursor.fail(error instanceof Error ? error : new Error(String(error)))
          )
        }),
    },
    next: {
      value: () => {
        let seen = 1
        return wrapper
          .start(() => (seen-- ? wrapper.continue() : wrapper.stop()))
          .then(() => wrapper)
      },
    },
  }) as DBCoreCursor
  return wrapper
}

function indexedPropertyRoots(table: DBCoreTable): Set<string> {
  const roots = new Set<string>()
  for (const index of [table.schema.primaryKey, ...table.schema.indexes]) {
    const paths = typeof index.keyPath === "string" ? [index.keyPath] : index.keyPath
    if (!paths) continue
    for (const path of paths) roots.add(path.split(".", 1)[0]!)
  }
  return roots
}

function isQueryableMetadataField(field: string): boolean {
  return (
    field === "id" ||
    field === "scope" ||
    field === "status" ||
    field.endsWith("Id") ||
    field.endsWith("At") ||
    field.endsWith("Count") ||
    field === "version"
  )
}

function isEncryptedEnvelope(value: unknown): value is EncryptedContentEnvelope {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    value.algorithm === "AES-256-GCM" &&
    typeof value.accountId === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
