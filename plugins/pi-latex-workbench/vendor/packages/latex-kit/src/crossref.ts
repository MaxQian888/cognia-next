/**
 * Work metadata from Crossref (api.crossref.org/works) and DataCite
 * (api.datacite.org/dois, which registers arXiv and dataset DOIs) → BibTeX.
 * Pure: the host performs the HTTP request with its own network policy and
 * hands the response body to `parseCrossrefWorks` / `parseDataciteWork`.
 */

/** A DOI, bare or as a doi:/doi.org reference; group 1 is the bare DOI. */
export const DOI_RE = /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;

/** The fields of a Crossref work item this module reads. */
export interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: Array<{ family?: string; given?: string }>;
  issued?: { "date-parts"?: number[][] };
  type?: string;
  URL?: string;
  publisher?: string;
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
}

/** The bare DOI when `text` is a DOI reference, otherwise null. */
export function matchDoi(text: string): string | null {
  return DOI_RE.exec(text.trim())?.[1] ?? null;
}

/**
 * The DOI arXiv registers for a new-style arXiv identifier (`1706.03762`,
 * `arXiv:1706.03762v5`, an abs or pdf URL), or null.
 */
export function arxivDoi(text: string): string | null {
  const m = /^(?:arxiv:\s*|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i.exec(text.trim());
  return m === null ? null : `10.48550/arXiv.${m[1]}`;
}

/** URL of one work by DOI. */
export function crossrefWorkUrl(doi: string): string {
  return `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
}

/** URL of a bibliographic search returning up to `rows` works. */
export function crossrefSearchUrl(query: string, rows = 5): string {
  const params = new URLSearchParams({ "query.bibliographic": query, rows: String(rows) });
  return `https://api.crossref.org/works?${params.toString()}`;
}

/**
 * Works in a Crossref response body: the list of a search, or the single
 * work of a DOI lookup. Null when the body is not JSON.
 */
export function parseCrossrefWorks(body: string): CrossrefItem[] | null {
  let parsed: { message?: { items?: unknown } | CrossrefItem };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return null;
  }
  const message = parsed?.message;
  if (message === undefined || message === null) return [];
  const items = (message as { items?: unknown }).items;
  if (Array.isArray(items)) return items as CrossrefItem[];
  return items === undefined ? [message as CrossrefItem] : [];
}

/** URL of one DataCite DOI record. */
export function dataciteWorkUrl(doi: string): string {
  return `https://api.datacite.org/dois/${encodeURIComponent(doi)}`;
}

/** DataCite citeproc type → the Crossref type with the same BibTeX entry. */
const DATACITE_TYPES: Record<string, string> = {
  "article-journal": "journal-article",
  "paper-conference": "proceedings-article",
  chapter: "book-chapter",
  book: "book",
  report: "report",
  thesis: "dissertation",
  dataset: "dataset",
};

interface DataciteAttributes {
  doi?: string;
  titles?: Array<{ title?: string }>;
  creators?: Array<{ name?: string; givenName?: string; familyName?: string; nameType?: string }>;
  publicationYear?: number | string;
  types?: { citeproc?: string };
  url?: string;
  publisher?: string | { name?: string };
  container?: { title?: string; volume?: string; issue?: string; firstPage?: string; lastPage?: string };
}

/**
 * A DataCite DOI record (JSON:API) in the Crossref item shape, so one
 * renderer serves both registries. Null when the body is not a record.
 */
export function parseDataciteWork(body: string): CrossrefItem | null {
  let attributes: DataciteAttributes | undefined;
  try {
    attributes = (JSON.parse(body) as { data?: { attributes?: DataciteAttributes } })?.data?.attributes;
  } catch {
    return null;
  }
  if (attributes === undefined || attributes === null) return null;
  const year = Number(attributes.publicationYear);
  const publisher = typeof attributes.publisher === "string" ? attributes.publisher : attributes.publisher?.name;
  const container = attributes.container ?? {};
  const item: CrossrefItem = {
    type: DATACITE_TYPES[attributes.types?.citeproc ?? ""] ?? "posted-content",
    title: attributes.titles?.[0]?.title !== undefined ? [attributes.titles[0].title] : [],
    author: (attributes.creators ?? []).map((creator) =>
      creator.familyName !== undefined
        ? { family: creator.familyName, ...(creator.givenName !== undefined && { given: creator.givenName }) }
        : { ...(creator.name !== undefined && { family: creator.name }) },
    ),
  };
  if (attributes.doi !== undefined) item.DOI = attributes.doi;
  if (Number.isInteger(year)) item.issued = { "date-parts": [[year]] };
  if (attributes.url !== undefined) item.URL = attributes.url;
  if (publisher !== undefined) item.publisher = publisher;
  if (container.title !== undefined) item["container-title"] = [container.title];
  if (container.volume !== undefined) item.volume = container.volume;
  if (container.issue !== undefined) item.issue = container.issue;
  if (container.firstPage !== undefined) {
    item.page = container.lastPage !== undefined ? `${container.firstPage}-${container.lastPage}` : container.firstPage;
  }
  return item;
}

/** Crossref work type → BibTeX entry type (unknown types stay @misc). */
export const CROSSREF_TYPES: Record<string, string> = {
  "journal-article": "article",
  "proceedings-article": "inproceedings",
  "book-chapter": "incollection",
  "book-section": "incollection",
  "book-part": "incollection",
  "reference-entry": "incollection",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  "reference-book": "book",
  "book-set": "book",
  proceedings: "proceedings",
  report: "techreport",
  "report-component": "techreport",
  dissertation: "phdthesis",
  standard: "misc",
  "posted-content": "misc",
  dataset: "misc",
};

/** Deterministic BibTeX rendering for a Crossref work item. */
export function renderBibEntry(item: CrossrefItem): string {
  const type = CROSSREF_TYPES[item.type ?? ""] ?? "misc";
  const firstAuthor = item.author?.[0]?.family?.toLowerCase().replace(/[^a-z0-9]/g, "") || "anon";
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  const firstWord = (item.title?.[0] ?? "work").split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "work";
  const key = `${firstAuthor}${year ?? "nd"}${firstWord}`;
  const clean = (v: string) => v.replace(/[{}]/g, "");
  const fields: [string, string][] = [
    // Inner braces keep the title's capitalization in every style.
    ["title", `{${clean(item.title?.[0] ?? "")}}`],
  ];
  if (item.author !== undefined && item.author.length > 0) {
    fields.push(["author", item.author.map((a) => `${a.family ?? ""}, ${a.given ?? ""}`.replace(/,\s*$/, "").trim()).join(" and ")]);
  }
  if (year !== undefined) fields.push(["year", String(year)]);
  const container = item["container-title"]?.[0];
  if (container !== undefined && type !== "book") {
    fields.push([type === "article" ? "journal" : "booktitle", `{${clean(container)}}`]);
  }
  // Crossref serves these for articles/chapters; BibTeX styles print them.
  if (item.volume !== undefined) fields.push(["volume", clean(item.volume)]);
  if (item.issue !== undefined) fields.push(["number", clean(item.issue)]);
  if (item.page !== undefined) fields.push(["pages", clean(item.page).replace(/\s*[-\u2013\u2014]+\s*/g, "--")]);
  if (item.DOI !== undefined) fields.push(["doi", item.DOI]);
  // arXiv DOIs carry the identifier BibTeX styles print for preprints.
  const arxiv = /^10\.48550\/arxiv\.(.+)$/i.exec(item.DOI ?? "");
  if (arxiv !== null) {
    fields.push(["eprint", arxiv[1] as string], ["archiveprefix", "arXiv"]);
  }
  if (item.URL !== undefined) fields.push(["url", item.URL]);
  if (item.publisher !== undefined) {
    fields.push([type === "techreport" ? "institution" : type === "phdthesis" ? "school" : "publisher", `{${clean(item.publisher)}}`]);
  }
  const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
  return `@${type}{${key},\n${body}\n}`;
}
