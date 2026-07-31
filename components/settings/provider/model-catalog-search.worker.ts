export interface CatalogSearchDocument {
  id: string
  searchText: string
}

export function filterCatalogSearchDocuments(
  documents: readonly CatalogSearchDocument[],
  query: string
): string[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return documents.map((document) => document.id)
  const terms = normalized.split(/\s+/)
  return documents
    .filter((document) => terms.every((term) => document.searchText.includes(term)))
    .map((document) => document.id)
}

type WorkerRequest =
  | { type: "init"; documents: CatalogSearchDocument[] }
  | { type: "search"; requestId: number; query: string }

let documents: CatalogSearchDocument[] = []

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
    if (event.data.type === "init") {
      documents = event.data.documents
      return
    }
    self.postMessage({
      type: "result",
      requestId: event.data.requestId,
      ids: filterCatalogSearchDocuments(documents, event.data.query),
    })
  })
}
