"""sqlite-based cache for analysis results."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import aiosqlite

from repowiki.host import PATHS

_DEFAULT_TTL = 365 * 24 * 3600  # 1 year

# Cache keys embed a content hash, so an entry is only wrong when the prompts
# or the model change, not when time passes. A year-long TTL therefore keeps
# re-runs of an unchanged repo free of LLM calls, and `repowiki cache-clear`
# is the explicit way to invalidate after a prompt/model change.


def content_hash(content: str) -> str:
    """sha256 hash truncated to 24 chars, used as cache key."""
    return hashlib.sha256(content.encode()).hexdigest()[:24]


class Cache:
    """async SQLite cache for LLM analysis results."""

    def __init__(self, db_path: str | Path | None = None):
        # No home-directory default. When the caller names no path the plugin's
        # host-injected data directory answers, and if the host never injected
        # one that is an error at connect time rather than a stray file in
        # someone's home.
        self._explicit_path = str(db_path) if db_path else None
        self._db: aiosqlite.Connection | None = None

    @property
    def db_path(self) -> str:
        return self._explicit_path or str(PATHS.cache_db)

    async def init(self):
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self.db_path)
        await self._db.execute(
            "CREATE TABLE IF NOT EXISTS cache "
            "(key TEXT PRIMARY KEY, value TEXT, created_at REAL)"
        )
        await self._db.commit()

    async def get(self, key: str, ttl: int = _DEFAULT_TTL) -> dict | list | None:
        if not self._db:
            return None
        cursor = await self._db.execute(
            "SELECT value, created_at FROM cache WHERE key = ?", (key,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        value, created_at = row
        if time.time() - created_at > ttl:
            await self._db.execute("DELETE FROM cache WHERE key = ?", (key,))
            await self._db.commit()
            return None
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None

    async def put(self, key: str, value: dict | list) -> None:
        if not self._db:
            return
        await self._db.execute(
            "INSERT OR REPLACE INTO cache (key, value, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(value, ensure_ascii=False), time.time()),
        )
        await self._db.commit()

    async def clear(self) -> int:
        """Wipe cached LLM results. Returns rows removed."""
        if not self._db:
            return 0
        cursor = await self._db.execute("SELECT COUNT(*) FROM cache")
        (count,) = await cursor.fetchone()
        await self._db.execute("DELETE FROM cache")
        await self._db.commit()
        return count

    async def close(self):
        if self._db:
            await self._db.close()
            self._db = None
