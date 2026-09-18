"""lightweight hybrid retrieval (TF-IDF + BM25) for Q&A chat.

Tokenization is identifier-aware: ``getUserById`` and ``is_authenticated``
are also indexed under their constituent sub-words so a query for
``user`` finds the camelCase getter, and ``auth`` finds the snake_case
predicate. A small stopword list trims code-noise words that otherwise
dominate the IDF tail.

Chunking respects language-specific section starts (def/class/function/
func/fn/method declarations) where possible, with a hard 60-line cap and
a small overlap between adjacent chunks so a reference straddling the
boundary is still recoverable. Wiki markdown is sliced separately by
heading sections so a question about the architecture page can hit the
wiki text directly rather than only the source files behind it.

Retrieval combines TF-IDF cosine similarity with BM25 scoring and
normalises both to ``[0, 1]`` before averaging. This keeps the
zero-dependency posture of the original TF-IDF retriever while picking
up BM25's better behaviour on long/short documents.
"""

from __future__ import annotations

import math
import re
from array import array
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass

from repowiki.core.models import ProjectContext

# Stop words tailored for source code: language keywords + universally
# common English words that drown out signal in the IDF tail.
_STOPWORDS: frozenset[str] = frozenset(
    {
        # English filler
        "a", "an", "and", "as", "at", "be", "by", "for", "from", "has",
        "have", "in", "is", "it", "its", "of", "on", "or", "that", "the",
        "this", "to", "was", "with",
        # control flow / common keywords
        "if", "else", "elif", "while", "for", "return", "yield", "break",
        "continue", "pass", "in", "not", "and", "or", "is", "true", "false",
        "none", "null", "void", "new", "var", "let", "const", "this",
        "self", "super", "try", "except", "catch", "finally", "throw",
        "throws", "raise", "with", "as", "import", "from", "use", "using",
        "package", "module", "namespace", "type", "interface", "enum",
        "struct", "trait", "impl", "fn", "func", "function", "def", "class",
        "public", "private", "protected", "static", "final", "abstract",
        "override", "async", "await",
    }
)

# Section-start patterns by language. Each pattern matches a line *start*
# that we treat as a natural chunk boundary.
_SECTION_START_RAW: dict[str, list[str]] = {
    "python": [
        r"^\s*(?:async\s+)?def\s+",
        r"^\s*class\s+",
        r"^\s*@\w",  # decorator above a def is a fine cut point too
    ],
    "javascript": [
        r"^\s*(?:export\s+)?(?:async\s+)?function\s+",
        r"^\s*(?:export\s+)?class\s+",
        r"^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(",
    ],
    "typescript": [],  # filled in below from javascript
    "go": [r"^\s*func\s+"],
    "rust": [
        r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+",
        r"^\s*impl\s+",
        r"^\s*struct\s+",
        r"^\s*enum\s+",
    ],
    "java": [r"^\s*(?:public|private|protected)\s+"],
    "kotlin": [
        r"^\s*(?:public|private|internal)?\s*fun\s+",
        r"^\s*class\s+",
    ],
}
# typescript shares js patterns + a few extras
_SECTION_START_RAW["typescript"] = _SECTION_START_RAW["javascript"] + [
    r"^\s*(?:export\s+)?interface\s+",
    r"^\s*(?:export\s+)?type\s+\w+\s*=",
]
# common aliases
for _alias_src, _alias_dsts in (
    ("javascript", ("jsx", "mjs", "cjs")),
    ("typescript", ("tsx",)),
):
    for _d in _alias_dsts:
        _SECTION_START_RAW[_d] = _SECTION_START_RAW[_alias_src]

_SECTION_START: dict[str, list[re.Pattern[str]]] = {
    lang: [re.compile(p) for p in pats]
    for lang, pats in _SECTION_START_RAW.items()
}


@dataclass
class Chunk:
    file_path: str
    line_start: int
    line_end: int
    content: str
    # ``code`` for source-file chunks, ``wiki`` for slices of generated
    # wiki markdown. The retrieval scorer is identical for both, but the
    # caller can prefer or annotate one over the other.
    kind: str = "code"
    score: float = 0.0


class SimpleRAG:
    """hybrid (TF-IDF + BM25) code retrieval, no external dependencies."""

    # Bumped when the on-disk schema changes; see ``rag_store.SCHEMA_VERSION``.
    SCHEMA_VERSION = 2

    def __init__(
        self,
        *,
        k1: float = 1.5,
        b: float = 0.75,
        max_chunk_lines: int = 60,
        soft_chunk_lines: int = 30,
        overlap_lines: int = 5,
    ):
        self.chunks: list[Chunk] = []
        self._idf: dict[str, float] = {}
        self._tf_vectors: list[Counter] = []
        # Per-chunk TF-IDF norm, index-aligned with ``chunks`` and valid for
        # the current ``_idf``. Retrieval used to recompute every one of
        # these per query — O(corpus tokens) each search — so they are kept
        # up alongside the tf vectors and recomputed in ``rebuild_global``.
        self._tfidf_norms: list[float] = []
        # Inverted index token -> sorted chunk ids. Chunks sharing no token
        # with the query score zero on both lexical channels, so scoring
        # only the union of the query's postings is exact — and turns a
        # query from O(corpus chunks) into O(matching chunks). ``None``
        # marks the index stale (any chunk mutation invalidates it); it is
        # rebuilt lazily in ``retrieve`` and eagerly in ``rebuild_global``.
        self._postings: dict[str, array] | None = None
        # BM25 needs per-chunk lengths and the corpus mean.
        self._chunk_lens: list[int] = []
        self._avgdl: float = 0.0
        # Optional third signal: one embedding vector per chunk, index-aligned
        # with ``chunks``. ``None`` marks a chunk that has not been embedded
        # (it arrived after the last embedding pass, or the pass failed) —
        # such a chunk still retrieves, it just scores on the lexical terms.
        self._vectors: list[list[float] | None] = []
        #: Embedding dimension of every stored vector; 0 means "lexical only".
        self.vector_dims: int = 0
        # BM25 tuning. The defaults are the classic values; expose them so
        # large/small repos can be retuned via Config without code changes.
        self._k1 = float(k1)
        self._b = float(b)
        # Chunking config retained on the instance so persistence + chat
        # paths use the same numbers we indexed with.
        self.max_chunk_lines = int(max_chunk_lines)
        self.soft_chunk_lines = int(soft_chunk_lines)
        self.overlap_lines = int(overlap_lines)
        # Incremental bookkeeping: which chunk indices belong to each file
        # and the content hash we indexed last (so callers can skip files
        # that didn't change).
        self._file_to_chunks: dict[str, list[int]] = {}
        self._file_sha: dict[str, str] = {}

    # ---------- bulk + incremental indexing ----------

    def index(self, project: ProjectContext) -> None:
        """chunk every project file and build the global statistics.

        Existing callers (the CLI ``chat`` command and the server's
        background preheat) get the original "from scratch" behaviour.
        """
        self.chunks = []
        self._vectors = []
        self._tf_vectors = []
        self._tfidf_norms = []
        self._chunk_lens = []
        self._postings = None
        self.vector_dims = 0
        self._file_to_chunks = {}
        self._file_sha = {}
        for f in project.files:
            text = f.content or f.preview
            if not text:
                continue
            self.upsert_file(
                f.path,
                sha=_fast_sha(text),
                language=f.language,
                text=text,
                kind="code",
                rebuild=False,
            )
        self.rebuild_global()

    def sync_project(self, project: ProjectContext) -> None:
        """Incrementally synchronize code chunks with the current project."""
        prior_code_paths = {
            path for path in self._file_sha if not path.startswith("wiki/")
        }
        seen: set[str] = set()
        for file in project.files:
            text = file.content or file.preview
            if not text:
                continue
            seen.add(file.path)
            sha = _fast_sha(text)
            if self._file_sha.get(file.path) != sha:
                self.upsert_file(
                    file.path,
                    sha=sha,
                    language=file.language,
                    text=text,
                    kind="code",
                    rebuild=False,
                )
        self.remove_files(prior_code_paths - seen, rebuild=False)
        self.rebuild_global()

    def upsert_file(
        self,
        path: str,
        sha: str,
        language: str,
        text: str,
        kind: str = "code",
        *,
        rebuild: bool = True,
    ) -> None:
        """add or replace a file's chunks in the index.

        When the same path is already indexed we drop its previous chunks
        first so the new ones cleanly replace them. Pass ``rebuild=False``
        to defer the global IDF/avgdl recompute (useful when upserting
        many files in a row).
        """
        if path in self._file_to_chunks:
            self.remove_file(path, rebuild=False)

        new_chunks = _chunk_for_kind(
            text,
            path,
            language,
            kind=kind,
            max_chunk_lines=self.max_chunk_lines,
            soft_chunk_lines=self.soft_chunk_lines,
            overlap_lines=self.overlap_lines,
        )
        if not new_chunks:
            self._file_sha[path] = sha
            return

        indices: list[int] = []
        for chunk in new_chunks:
            idx = len(self.chunks)
            self.chunks.append(chunk)
            tokens = _tokenize(chunk.content)
            self._tf_vectors.append(Counter(tokens))
            self._tfidf_norms.append(_tfidf_norm(self._tf_vectors[-1], self._idf))
            self._chunk_lens.append(max(1, len(tokens)))
            self._vectors.append(None)
            indices.append(idx)
        # New chunks aren't in the postings yet — invalidate so the next
        # retrieve rebuilds rather than silently missing them.
        self._postings = None

        self._file_to_chunks[path] = indices
        self._file_sha[path] = sha

        if rebuild:
            self.rebuild_global()

    def remove_file(self, path: str, *, rebuild: bool = True) -> None:
        """drop every chunk that belongs to ``path``."""
        self.remove_files([path], rebuild=rebuild)

    def remove_files(self, paths, *, rebuild: bool = True) -> None:
        """drop every chunk that belongs to any of ``paths`` in one pass.

        Removing one path at a time rebuilds the whole chunk array per
        file — O(paths × total chunks) — which is what a wiki re-index or a
        mass deletion used to pay. Here the drop set is gathered first so
        the arrays are rebuilt once.

        We rebuild the chunk array rather than punching holes, because the
        BM25 / TF-IDF passes both need ``self.chunks`` and
        ``self._tf_vectors`` to stay index-aligned.
        """
        drop: set[int] = set()
        for path in paths:
            indices = self._file_to_chunks.pop(path, None)
            self._file_sha.pop(path, None)
            if indices:
                drop.update(indices)
        if drop:
            self._rebuild_after_removal(drop)
        if rebuild:
            self.rebuild_global()

    def _rebuild_after_removal(self, drop: set[int]) -> None:
        """compact every index-aligned array minus the ``drop`` chunk ids."""
        kept_chunks: list[Chunk] = []
        kept_tf: list[Counter] = []
        kept_norms: list[float] = []
        kept_lens: list[int] = []
        kept_vectors: list[list[float] | None] = []
        # Map old chunk index -> new index so we can rewrite the
        # per-file bookkeeping for the files we kept.
        remap: dict[int, int] = {}
        for old_idx, chunk in enumerate(self.chunks):
            if old_idx in drop:
                continue
            remap[old_idx] = len(kept_chunks)
            kept_chunks.append(chunk)
            kept_tf.append(self._tf_vectors[old_idx])
            kept_norms.append(
                self._tfidf_norms[old_idx]
                if old_idx < len(self._tfidf_norms)
                else _tfidf_norm(self._tf_vectors[old_idx], self._idf)
            )
            kept_lens.append(self._chunk_lens[old_idx])
            kept_vectors.append(
                self._vectors[old_idx] if old_idx < len(self._vectors) else None
            )

        self.chunks = kept_chunks
        self._tf_vectors = kept_tf
        self._tfidf_norms = kept_norms
        self._chunk_lens = kept_lens
        self._vectors = kept_vectors
        # Postings reference pre-remap chunk ids — stale, not just stale-
        # valued. Rebuild lazily rather than remap every posting list.
        self._postings = None
        # Rewire surviving files' chunk-index lists.
        for other_path, idxs in self._file_to_chunks.items():
            self._file_to_chunks[other_path] = [remap[i] for i in idxs if i in remap]

    def rebuild_global(self) -> None:
        """recompute IDF, avgdl and per-chunk norms after a batch of mutations."""
        doc_count = len(self.chunks)
        if doc_count == 0:
            self._idf = {}
            self._avgdl = 0.0
            self._tfidf_norms = []
            self._postings = {}
            return

        df: Counter = Counter()
        postings: dict[str, array] = {}
        for i, tf in enumerate(self._tf_vectors):
            for token in tf:
                df[token] += 1
                postings.setdefault(token, array("I")).append(i)

        # Smoothed IDF (sklearn-style): always > 0 even when a term appears
        # in every document, and remains finite on tiny corpora.
        self._idf = {
            token: math.log((doc_count + 1) / (count + 1)) + 1.0
            for token, count in df.items()
        }
        self._avgdl = sum(self._chunk_lens) / doc_count
        self._postings = postings
        self.recompute_norms()

    def _ensure_postings(self) -> dict[str, array]:
        """Materialise the inverted index, rebuilding it when a mutation
        left it stale. ``rebuild_global`` fills it eagerly; this is the
        fallback for callers that query between mutation and rebuild."""
        if self._postings is None:
            postings: dict[str, array] = {}
            for i, tf in enumerate(self._tf_vectors):
                for token in tf:
                    postings.setdefault(token, array("I")).append(i)
            self._postings = postings
        return self._postings

    def recompute_norms(self) -> None:
        """refresh ``_tfidf_norms`` against the current ``_idf``.

        Called by ``rebuild_global`` after the idf pass, and by the store's
        ``load`` — which restores idf from the snapshot rather than
        recomputing it — so a rehydrated index never pays per-query norms.
        """
        self._tfidf_norms = [
            _tfidf_norm(tf, self._idf) for tf in self._tf_vectors
        ]

    # ---------- semantic layer ----------

    def set_vectors(
        self, vectors: list[list[float] | None], *, dims: int = 0
    ) -> None:
        """Attach embedding vectors, index-aligned with ``chunks``.

        ``None`` entries are allowed — a chunk without a vector simply scores
        on the lexical terms alone. ``dims`` records the embedding width so a
        query vector from a different model is refused rather than silently
        scoring garbage.
        """
        if len(vectors) != len(self.chunks):
            raise ValueError(
                f"vectors length {len(vectors)} != chunks length {len(self.chunks)}"
            )
        self._vectors = [list(v) if v is not None else None for v in vectors]
        self.vector_dims = int(dims) or next(
            (len(v) for v in self._vectors if v is not None), 0
        )

    # ---------- retrieval ----------

    def retrieve(
        self,
        query: str,
        top_k: int = 5,
        *,
        min_score: float = 0.0,
        query_vector: list[float] | None = None,
        include: Callable[[Chunk], bool] | None = None,
    ) -> list[Chunk]:
        """find top-k chunks most relevant to ``query``.

        Score is the average of TF-IDF cosine similarity and BM25, each
        normalised to ``[0, 1]`` by dividing by their respective max
        across the corpus — plus a third normalised cosine term when both a
        ``query_vector`` and stored chunk vectors exist. The single-score
        view makes ``min_score`` meaningful regardless of corpus size.

        ``include`` scopes the retrieval universe: only chunks it accepts
        are scored or ranked, so a scoped search's normalisation happens
        within the scope — the same answer an index of just those chunks
        would give.
        """
        if not self.chunks:
            return []

        query_tokens = _tokenize(query)
        if not query_tokens:
            return []
        query_tf = Counter(query_tokens)

        n = len(self.chunks)
        idf = self._idf
        norms = self._tfidf_norms
        query_norm = _tfidf_norm(query_tf, idf)

        # Only chunks sharing a token with the query can score on either
        # lexical channel — everyone else is exactly 0, so the postings
        # union is the whole candidate set. Exactness, not approximation.
        postings = self._ensure_postings()
        candidates: set[int] = set()
        for token in query_tf:
            idxs = postings.get(token)
            if idxs is not None:
                candidates.update(idxs)
        if include is not None:
            candidates = {i for i in candidates if include(self.chunks[i])}

        tfidf_scores: dict[int, float] = {}
        bm25_scores: dict[int, float] = {}
        for i in candidates:
            tf_vec = self._tf_vectors[i]
            # Same cosine as _cosine_similarity with both norms hoisted:
            # the query's once per call, each chunk's once per rebuild.
            common = set(query_tf) & set(tf_vec)
            if common:
                dot = sum(
                    query_tf[t] * idf.get(t, 0) * tf_vec[t] * idf.get(t, 0)
                    for t in common
                )
                norm_b = (
                    norms[i]
                    if i < len(norms)
                    else _tfidf_norm(tf_vec, idf)
                )
                tfidf_scores[i] = (
                    dot / (query_norm * norm_b) if query_norm and norm_b else 0.0
                )
            else:
                tfidf_scores[i] = 0.0
            bm25_scores[i] = _bm25(
                query_tokens, tf_vec, self._chunk_lens[i],
                idf, self._avgdl, self._k1, self._b,
            )

        # The vector pass only runs when the index actually carries vectors
        # of the same width — a mismatched model's scores would be noise, not
        # a signal, and a lexical-only index must not pay the divide-by-three.
        vec_scores: dict[int, float] | None = None
        if (
            query_vector
            and self.vector_dims
            and len(query_vector) == self.vector_dims
            and any(v is not None for v in self._vectors)
        ):
            vec_scores = {}
            for i in range(n):
                vec = self._vectors[i] if i < len(self._vectors) else None
                if vec is not None:
                    vec_scores[i] = max(0.0, _dense_cosine(query_vector, vec))

        max_tfidf = max(tfidf_scores.values()) if tfidf_scores else 0.0
        max_bm25 = max(bm25_scores.values()) if bm25_scores else 0.0
        max_vec = max(vec_scores.values()) if vec_scores else 0.0

        # Chunks outside the candidate set score 0 lexically; when the
        # vector pass ran, a vectorized chunk can still rank on that signal
        # alone (a paraphrase may share no vocabulary with the code).
        scored = candidates
        if vec_scores is not None:
            scored = candidates | {
                i
                for i, s in vec_scores.items()
                if s > 0 and (include is None or include(self.chunks[i]))
            }

        fused: list[tuple[float, int]] = []
        terms = 3 if vec_scores is not None else 2
        for i in scored:
            tfidf_n = tfidf_scores.get(i, 0.0) / max_tfidf if max_tfidf > 0 else 0.0
            bm25_n = bm25_scores.get(i, 0.0) / max_bm25 if max_bm25 > 0 else 0.0
            total = tfidf_n + bm25_n
            if vec_scores is not None:
                total += vec_scores.get(i, 0.0) / max_vec if max_vec > 0 else 0.0
            fused.append((total / terms, i))

        fused.sort(reverse=True)
        results: list[Chunk] = []
        for score, idx in fused[:top_k]:
            if score <= 0 or score < min_score:
                break
            chunk = self.chunks[idx]
            chunk.score = score
            results.append(chunk)
        return results

    # ---------- wiki indexing helper ----------

    def index_wiki_pages(self, pages: list) -> None:
        """slice generated wiki markdown into chunks and add them.

        ``pages`` is a list of objects with ``id`` and ``content`` (a
        :class:`repowiki.core.wiki_builder.WikiPage` works). Wiki paths that
        no longer appear are dropped in one pass, and a page whose content
        hash is unchanged keeps its existing chunks — re-adding identical
        content would throw away its persisted embedding vectors and force
        a redundant embed pass on every restart.
        """
        wanted: dict[str, tuple[str, str]] = {}
        for page in pages:
            content = getattr(page, "content", "") or ""
            page_id = getattr(page, "id", "") or "page"
            if not content.strip():
                continue
            wanted[f"wiki/{page_id}.md"] = (content, _fast_sha(content))

        stale = [
            path
            for path in self._file_sha
            if path.startswith("wiki/") and path not in wanted
        ]
        if stale:
            self.remove_files(stale, rebuild=False)

        dirty = bool(stale)
        for virtual_path, (content, sha) in wanted.items():
            if self._file_sha.get(virtual_path) == sha:
                continue
            self.upsert_file(
                virtual_path,
                sha=sha,
                language="markdown",
                text=content,
                kind="wiki",
                rebuild=False,
            )
            dirty = True
        # Nothing changed -> the rebuilt idf/norms would be identical to the
        # ones already in memory, so skip the O(corpus) pass. The second
        # clause heals a caller that fed rebuild=False upserts and never
        # rebuilt: chunks without an idf still get their globals.
        if dirty or (self.chunks and not self._idf):
            self.rebuild_global()


# ----- helpers (token / chunking / scoring) ---------------------------


_IDENT_RE = re.compile(r"[a-zA-Z_]\w*")
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _split_identifier(token: str) -> list[str]:
    """yield sub-words for camelCase and snake_case identifiers.

    Always includes the original lowercased token so existing exact-match
    behaviour is preserved.
    """
    pieces: list[str] = [token.lower()]
    # snake_case
    if "_" in token:
        for p in token.split("_"):
            if p:
                pieces.append(p.lower())
    # camelCase / PascalCase
    camel_parts = _CAMEL_BOUNDARY.split(token)
    if len(camel_parts) > 1:
        for p in camel_parts:
            if p:
                pieces.append(p.lower())
    return pieces


def format_context(chunks: list[Chunk]) -> str:
    """Render retrieved chunks into a prompt-ready context block.

    Each chunk becomes a fenced section labelled with its file path and line
    range, so the model can cite specific locations. Empty input yields a
    short placeholder rather than a blank prompt.
    """
    if not chunks:
        return "(no relevant code found in this repository)"
    blocks = []
    for c in chunks:
        blocks.append(
            f"### {c.file_path} (lines {c.line_start}-{c.line_end})\n```\n{c.content}\n```"
        )
    return "\n\n".join(blocks)


def format_context_grouped(chunks: list[Chunk]) -> str:
    """The file-grouped variant, for prompts that cite whole files.

    Chunks keep retrieval order inside each file and files keep first-hit
    order, with ``[lines A-B]`` markers the model quotes back when it cites
    a range — the codemap prompt's citation contract is written against this
    layout, not the per-chunk one above.
    """
    if not chunks:
        return "(no relevant code found in this repository)"
    by_file: dict[str, list[Chunk]] = {}
    for chunk in chunks:
        by_file.setdefault(chunk.file_path, []).append(chunk)
    parts = []
    for path, group in by_file.items():
        body = "\n\n".join(
            f"[lines {c.line_start}-{c.line_end}]\n{c.content}" for c in group
        )
        parts.append(f"## File Path: {path}\n\n{body}")
    return ("\n\n" + "-" * 10 + "\n\n").join(parts)


def _tokenize(text: str) -> list[str]:
    """split text into lowercase tokens, also emitting camelCase/snake_case
    sub-words. Stopwords are filtered.
    """
    out: list[str] = []
    for raw in _IDENT_RE.findall(text):
        for piece in _split_identifier(raw):
            if len(piece) < 2:
                continue
            if piece in _STOPWORDS:
                continue
            out.append(piece)
    return out


def _dense_cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity over plain float lists — no numpy on this box."""
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / math.sqrt(na * nb)


def _tfidf_norm(tf_vec: Counter, idf: dict[str, float]) -> float:
    """The TF-IDF vector's length — the cosine denominator ``retrieve``
    precomputes once per rebuild instead of once per chunk per query."""
    return math.sqrt(sum((tf_vec[t] * idf.get(t, 0)) ** 2 for t in tf_vec))


def _cosine_similarity(vec_a: Counter, vec_b: Counter, idf: dict[str, float]) -> float:
    """TF-IDF weighted cosine similarity."""
    common = set(vec_a) & set(vec_b)
    if not common:
        return 0.0

    dot = sum(vec_a[t] * idf.get(t, 0) * vec_b[t] * idf.get(t, 0) for t in common)
    norm_a = math.sqrt(sum((vec_a[t] * idf.get(t, 0)) ** 2 for t in vec_a))
    norm_b = math.sqrt(sum((vec_b[t] * idf.get(t, 0)) ** 2 for t in vec_b))

    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _bm25(
    query_tokens: list[str],
    tf_vec: Counter,
    chunk_len: int,
    idf: dict[str, float],
    avgdl: float,
    k1: float,
    b: float,
) -> float:
    """BM25 score for a single document.

    Uses the same IDF table as the TF-IDF cosine path (smoothed), which
    keeps both scorers consistent without a second pass over the corpus.
    """
    if avgdl <= 0:
        return 0.0
    score = 0.0
    norm = (1.0 - b) + b * (chunk_len / avgdl)
    for token in set(query_tokens):
        if token not in idf:
            continue
        f = tf_vec.get(token, 0)
        if f == 0:
            continue
        score += idf[token] * f * (k1 + 1.0) / (f + k1 * norm)
    return score


def _chunk_for_kind(
    text: str,
    file_path: str,
    language: str,
    *,
    kind: str,
    max_chunk_lines: int,
    soft_chunk_lines: int,
    overlap_lines: int,
) -> list[Chunk]:
    """dispatch to the right chunker and tag the chunks with ``kind``."""
    if kind == "wiki":
        chunks = _split_markdown_into_chunks(
            text, file_path, max_lines=max_chunk_lines,
        )
    else:
        chunks = _split_into_chunks(
            text,
            file_path,
            language=language,
            max_chunk_lines=max_chunk_lines,
            soft_chunk_lines=soft_chunk_lines,
            overlap_lines=overlap_lines,
        )
    for c in chunks:
        c.kind = kind
    return chunks


def _split_into_chunks(
    text: str,
    file_path: str,
    language: str = "",
    max_chunk_lines: int = 60,
    soft_chunk_lines: int = 30,
    overlap_lines: int = 5,
) -> list[Chunk]:
    """split file content into chunks.

    Strategy:
      1. Detect language-specific *section starts* (def/class/function/etc.)
         and prefer to begin a chunk there.
      2. Allow up to ``soft_chunk_lines`` of slop before we look for a
         section start; once we exceed ``max_chunk_lines`` we cut hard.
      3. Carry the trailing ``overlap_lines`` of each chunk into the next,
         so a reference straddling a boundary still appears in both.

    Falls back to the original blank-line heuristic for languages we don't
    recognize.
    """
    lines = text.splitlines()
    if not lines:
        return []

    section_patterns = _SECTION_START.get(language)
    if not section_patterns:
        return _split_by_blank_lines(lines, file_path, max_lines=soft_chunk_lines)

    chunks: list[Chunk] = []
    current_start = 0
    current: list[str] = []

    def _flush(start_idx: int, buf: list[str]) -> None:
        """emit the current chunk if it has content."""
        if not buf:
            return
        joined = "\n".join(buf)
        if joined.strip():
            chunks.append(
                Chunk(
                    file_path=file_path,
                    line_start=start_idx + 1,
                    line_end=start_idx + len(buf),
                    content=joined,
                )
            )

    def _is_section_start(line: str) -> bool:
        return any(p.search(line) for p in section_patterns)

    for i, line in enumerate(lines):
        # treat a section start as a cut point if we already have at least
        # soft_chunk_lines accumulated. This keeps decorators glued to their
        # def, and short helper clusters grouped together.
        if (
            _is_section_start(line)
            and len(current) >= soft_chunk_lines
        ):
            _flush(current_start, current)
            tail = current[-overlap_lines:] if overlap_lines else []
            # next chunk starts at the overlap window, not at i
            current_start = i - len(tail)
            current = list(tail)

        current.append(line)

        # hard cap: even mid-function we must break
        if len(current) >= max_chunk_lines:
            _flush(current_start, current)
            tail = current[-overlap_lines:] if overlap_lines else []
            current_start = i + 1 - len(tail)
            current = list(tail)

    _flush(current_start, current)
    return chunks


def _split_by_blank_lines(
    lines: list[str], file_path: str, max_lines: int = 30
) -> list[Chunk]:
    """fallback chunker -- original blank-line heuristic.

    Used for languages we don't have section-start patterns for.
    """
    chunks: list[Chunk] = []
    current_start = 0
    current_lines: list[str] = []
    for i, line in enumerate(lines):
        current_lines.append(line)
        is_boundary = line.strip() == "" and len(current_lines) >= 5
        is_too_long = len(current_lines) >= max_lines
        if is_boundary or is_too_long or i == len(lines) - 1:
            if current_lines:
                content = "\n".join(current_lines)
                if content.strip():
                    chunks.append(
                        Chunk(
                            file_path=file_path,
                            line_start=current_start + 1,
                            line_end=current_start + len(current_lines),
                            content=content,
                        )
                    )
                current_start = i + 1
                current_lines = []
    return chunks


_HEADING_RE = re.compile(r"^#{1,6}\s+")


def _split_markdown_into_chunks(
    text: str, file_path: str, *, max_lines: int = 60
) -> list[Chunk]:
    """slice markdown into chunks by heading sections.

    Each ``#`` / ``##`` / ... heading starts a new chunk. If a single
    section exceeds ``max_lines`` it's split again at the heading-less
    line cap so a long page doesn't become one giant chunk.
    """
    lines = text.splitlines()
    if not lines:
        return []

    chunks: list[Chunk] = []
    section_start = 0
    section_lines: list[str] = []

    def _flush_section() -> None:
        if not section_lines:
            return
        # Inside a section, split further if it exceeds the line cap.
        for offset in range(0, len(section_lines), max_lines):
            piece = section_lines[offset : offset + max_lines]
            joined = "\n".join(piece).strip()
            if not joined:
                continue
            chunks.append(
                Chunk(
                    file_path=file_path,
                    line_start=section_start + offset + 1,
                    line_end=section_start + offset + len(piece),
                    content="\n".join(piece),
                )
            )

    for i, line in enumerate(lines):
        if _HEADING_RE.match(line) and section_lines:
            _flush_section()
            section_start = i
            section_lines = [line]
        else:
            section_lines.append(line)

    _flush_section()
    return chunks


def _fast_sha(text: str) -> str:
    """short content hash for incremental staleness checks.

    Mirrors :func:`repowiki.core.cache.content_hash` (sha256 -> 24 chars)
    so the analyzer cache and the RAG index can share the same digest of a
    file body without re-hashing it twice.
    """
    import hashlib
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:24]
