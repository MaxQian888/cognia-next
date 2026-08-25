"""Configuration, sourced from the host instead of the user's home directory.

Upstream read ``~/.repowiki/config.json`` and a ``.env`` file, and fell back to
``DEEPSEEK_API_KEY`` / ``OPENAI_API_KEY`` / ``ANTHROPIC_API_KEY`` from the
environment. A plugin does neither: it has no business reading the user's home
directory or their provider keys, and it does not need them — every model call
goes through ``ctx.agent``, which resolves the provider, the key and the
routing on the host side.

What survives is the tuning surface: chunk sizes, top-k, BM25 constants, token
budget, concurrency. Those are the user's to set, so they arrive through the
plugin's own ``configSchema`` via :func:`Config.from_host`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

def resolve_model(name: str) -> str:
    """Pass a model id through untouched.

    Upstream kept a table of shortcuts (``opus`` → ``anthropic/claude-opus-4-5``
    and a dozen more) because litellm needed a fully-qualified
    ``provider/model`` string. The plugin never talks to a provider: it hands
    the id to ``ctx.agent.run``, and the host's own provider routing resolves
    it against the models the user has actually configured. A second table here
    would only be able to go stale, and would name providers the user may not
    have — the exact drift ADR-0087 recorded.
    """
    return name.strip()


@dataclass
class Config:
    #: Empty means "let the host pick". A model id here is passed to
    #: ``ctx.agent.run`` and must be one the host's provider routing knows.
    model: str = ""
    #: Retained for shape-compatibility with upstream and always empty: the
    #: host holds provider credentials and a plugin never sees them.
    api_key: str = ""
    api_base: str = ""
    language: str = "en"
    max_file_size: int = 200 * 1024  # 200 KB
    max_files: int = 1000
    output_dir: str = "./wiki"
    concurrency: int = 5
    # token budget for the slice of project context we ship to the LLM
    # (overview / architecture / reading-guide passes). 0 = unlimited.
    max_context_tokens: int = 32_000
    # --- RAG / chat retrieval tuning --------------------------------------
    # All of these are runtime-tunable so the user can adjust to repo shape
    # without touching code. Defaults reproduce the original behaviour.
    rag_chunk_max_lines: int = 60
    rag_chunk_soft_lines: int = 30
    rag_chunk_overlap_lines: int = 5
    rag_top_k: int = 5
    rag_min_score: float = 0.0
    rag_bm25_k1: float = 1.5
    rag_bm25_b: float = 0.75
    # When true, also feed the generated wiki markdown into the chat index
    # so questions about the architecture page hit the page directly.
    rag_index_wiki: bool = True

    @classmethod
    def from_host(cls, values: dict | None = None) -> Config:
        """Build a config from the plugin's persisted ``configSchema`` values.

        Unknown keys are ignored rather than rejected: the host is free to add
        settings ahead of a plugin that understands them, and a plugin pinned
        to an older schema must keep loading.
        """
        data = {
            key: value
            for key, value in (values or {}).items()
            if key in cls.__dataclass_fields__ and value is not None
        }
        cfg = cls(**data)
        cfg.concurrency = max(1, int(cfg.concurrency or 1))
        cfg.max_context_tokens = max(0, int(cfg.max_context_tokens or 0))
        cfg.model = resolve_model(cfg.model) if cfg.model else ""
        # Credentials never travel into the plugin; drop anything that
        # somehow arrived in the settings blob rather than carrying it around.
        cfg.api_key = ""
        cfg.api_base = ""
        return cfg

    @classmethod
    def load(cls) -> Config:
        """Offline entry point — defaults plus the few test-facing env knobs.

        Upstream's ``load`` merged a home-directory config file, a ``.env`` and
        a dozen ``REPOWIKI_*`` variables. In the plugin the host owns that job
        (:meth:`from_host`); this stays so the vendored unit tests, which
        construct a Config without a host, keep working.
        """
        cfg = cls()

        def _int_env(name: str, default: int) -> int:
            val = os.getenv(name)
            if not val:
                return default
            try:
                return int(val)
            except ValueError:
                return default

        def _float_env(name: str, default: float) -> float:
            val = os.getenv(name)
            if not val:
                return default
            try:
                return float(val)
            except ValueError:
                return default

        cfg.language = os.getenv("REPOWIKI_LANG") or cfg.language
        cfg.concurrency = max(1, _int_env("REPOWIKI_CONCURRENCY", cfg.concurrency))
        cfg.max_context_tokens = max(
            0, _int_env("REPOWIKI_MAX_CONTEXT_TOKENS", cfg.max_context_tokens)
        )
        cfg.rag_chunk_max_lines = _int_env("REPOWIKI_RAG_CHUNK_MAX_LINES", cfg.rag_chunk_max_lines)
        cfg.rag_chunk_soft_lines = _int_env(
            "REPOWIKI_RAG_CHUNK_SOFT_LINES", cfg.rag_chunk_soft_lines
        )
        cfg.rag_chunk_overlap_lines = _int_env(
            "REPOWIKI_RAG_CHUNK_OVERLAP", cfg.rag_chunk_overlap_lines
        )
        cfg.rag_top_k = _int_env("REPOWIKI_RAG_TOP_K", cfg.rag_top_k)
        cfg.rag_min_score = _float_env("REPOWIKI_RAG_MIN_SCORE", cfg.rag_min_score)
        cfg.rag_bm25_k1 = _float_env("REPOWIKI_RAG_BM25_K1", cfg.rag_bm25_k1)
        cfg.rag_bm25_b = _float_env("REPOWIKI_RAG_BM25_B", cfg.rag_bm25_b)
        if (val := os.getenv("REPOWIKI_RAG_INDEX_WIKI")) is not None:
            cfg.rag_index_wiki = val.strip().lower() not in ("0", "false", "no", "")
        return cfg

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}
