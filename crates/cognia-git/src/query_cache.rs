//! Immutable-key cache for history and blame (ADR-0227 §6).
//!
//! A history walk or a blame is a pure function of a commit: the same commit,
//! path and options always produce the same answer. So the key carries the
//! *resolved* commit id, never a ref name, and nothing ever has to be
//! invalidated — a new commit is a new key, and the old entry ages out of the
//! LRU. This is the small-machine version of Scion's derived data: computed
//! once per commit, served from memory after that.
//!
//! The one mutable input is the working tree. A working-tree blame (`rev =
//! None`) is cached only when the file is unmodified against HEAD, because
//! then it IS the blame at HEAD; a modified file is blamed fresh every time.
//!
//! Keys also carry the canonical Git common dir, so the linked worktrees of one
//! repository share entries: five agents reading the history of the same file
//! at the same commit cost one walk.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use super::types::{GitBlameLine, GitCommit};

/// Entries kept at most. A key is cheap; the bound is for the values.
pub const MAX_ENTRIES: usize = 256;
/// Approximate bytes kept at most, summed over string payloads.
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum QueryKey {
    Log {
        common_dir: PathBuf,
        head: String,
        path: Option<String>,
        skip: usize,
        max_count: usize,
    },
    Blame {
        common_dir: PathBuf,
        commit: String,
        path: String,
    },
}

#[derive(Debug, Clone)]
pub enum QueryValue {
    Log(Arc<Vec<GitCommit>>),
    Blame(Arc<Vec<GitBlameLine>>),
}

impl QueryValue {
    fn approximate_bytes(&self) -> usize {
        match self {
            QueryValue::Log(commits) => commits
                .iter()
                .map(|c| {
                    96 + c.hash.len()
                        + c.short_hash.len()
                        + c.summary.len()
                        + c.body.len()
                        + c.author_name.len()
                        + c.author_email.len()
                        + c.parents.iter().map(String::len).sum::<usize>()
                })
                .sum(),
            QueryValue::Blame(lines) => lines
                .iter()
                .map(|l| {
                    64 + l.commit_hash.len()
                        + l.short_hash.len()
                        + l.author_name.len()
                        + l.summary.len()
                        + l.content.len()
                })
                .sum(),
        }
    }
}

struct Entry {
    value: QueryValue,
    bytes: usize,
    last_used: u64,
}

/// A bounded LRU over [`QueryKey`]. Eviction scans for the oldest entry: with
/// at most [`MAX_ENTRIES`] rows that is cheaper than keeping a second index.
pub struct QueryCache {
    entries: HashMap<QueryKey, Entry>,
    bytes: usize,
    tick: u64,
    max_entries: usize,
    max_bytes: usize,
    hits: u64,
    misses: u64,
}

/// Counters for diagnostics and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryCacheStats {
    pub entries: usize,
    pub bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

impl QueryCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            tick: 0,
            max_entries: max_entries.max(1),
            max_bytes,
            hits: 0,
            misses: 0,
        }
    }

    pub fn get(&mut self, key: &QueryKey) -> Option<QueryValue> {
        self.tick += 1;
        let tick = self.tick;
        match self.entries.get_mut(key) {
            Some(entry) => {
                entry.last_used = tick;
                self.hits += 1;
                Some(entry.value.clone())
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }

    pub fn insert(&mut self, key: QueryKey, value: QueryValue) {
        let bytes = value.approximate_bytes();
        // A single answer bigger than the whole budget is served, not kept.
        if bytes > self.max_bytes {
            return;
        }
        self.tick += 1;
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes -= previous.bytes;
        }
        while !self.entries.is_empty()
            && (self.entries.len() >= self.max_entries || self.bytes + bytes > self.max_bytes)
        {
            self.evict_oldest();
        }
        self.bytes += bytes;
        self.entries.insert(
            key,
            Entry {
                value,
                bytes,
                last_used: self.tick,
            },
        );
    }

    fn evict_oldest(&mut self) {
        let Some(oldest) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
        else {
            return;
        };
        if let Some(entry) = self.entries.remove(&oldest) {
            self.bytes -= entry.bytes;
        }
    }

    pub fn stats(&self) -> QueryCacheStats {
        QueryCacheStats {
            entries: self.entries.len(),
            bytes: self.bytes,
            hits: self.hits,
            misses: self.misses,
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
}

static CACHE: Lazy<Mutex<QueryCache>> =
    Lazy::new(|| Mutex::new(QueryCache::new(MAX_ENTRIES, MAX_BYTES)));

/// The process-wide cache. The guard is never held across an `.await` or a git
/// call: callers look up, release, compute, then insert.
pub fn global() -> &'static Mutex<QueryCache> {
    &CACHE
}

pub fn cached_log(key: &QueryKey) -> Option<Arc<Vec<GitCommit>>> {
    match global().lock().get(key) {
        Some(QueryValue::Log(commits)) => Some(commits),
        _ => None,
    }
}

pub fn store_log(key: QueryKey, commits: Arc<Vec<GitCommit>>) {
    global().lock().insert(key, QueryValue::Log(commits));
}

pub fn cached_blame(key: &QueryKey) -> Option<Arc<Vec<GitBlameLine>>> {
    match global().lock().get(key) {
        Some(QueryValue::Blame(lines)) => Some(lines),
        _ => None,
    }
}

pub fn store_blame(key: QueryKey, lines: Arc<Vec<GitBlameLine>>) {
    global().lock().insert(key, QueryValue::Blame(lines));
}

/// The canonical common dir of the repository at `repo`: shared by every
/// linked worktree, so their entries are shared too.
pub fn common_dir_of(repo: &git2::Repository) -> PathBuf {
    let dir = repo.commondir();
    dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(hash: &str, summary: &str) -> GitCommit {
        GitCommit {
            hash: hash.to_string(),
            short_hash: hash.chars().take(7).collect(),
            summary: summary.to_string(),
            body: String::new(),
            author_name: "a".into(),
            author_email: "a@example.com".into(),
            authored_at_ms: 0,
            parents: vec![],
        }
    }

    fn log_key(head: &str) -> QueryKey {
        QueryKey::Log {
            common_dir: PathBuf::from("/repo/.git"),
            head: head.into(),
            path: None,
            skip: 0,
            max_count: 50,
        }
    }

    #[test]
    fn a_hit_returns_the_stored_value_and_counts() {
        let mut cache = QueryCache::new(8, 1 << 20);
        let value = QueryValue::Log(Arc::new(vec![commit("aaaaaaa1", "one")]));
        cache.insert(log_key("h1"), value);
        assert!(
            matches!(cache.get(&log_key("h1")), Some(QueryValue::Log(c)) if c[0].summary == "one")
        );
        assert!(cache.get(&log_key("h2")).is_none());
        let stats = cache.stats();
        assert_eq!((stats.hits, stats.misses, stats.entries), (1, 1, 1));
    }

    #[test]
    fn evicts_the_least_recently_used_entry_at_the_entry_cap() {
        let mut cache = QueryCache::new(2, 1 << 20);
        cache.insert(log_key("h1"), QueryValue::Log(Arc::new(vec![])));
        cache.insert(log_key("h2"), QueryValue::Log(Arc::new(vec![])));
        // Touch h1 so h2 becomes the oldest.
        assert!(cache.get(&log_key("h1")).is_some());
        cache.insert(log_key("h3"), QueryValue::Log(Arc::new(vec![])));
        assert!(cache.get(&log_key("h1")).is_some());
        assert!(cache.get(&log_key("h2")).is_none());
        assert!(cache.get(&log_key("h3")).is_some());
    }

    #[test]
    fn evicts_by_bytes_and_never_keeps_an_oversized_answer() {
        let big = "x".repeat(400);
        let mut cache = QueryCache::new(16, 1_000);
        cache.insert(
            log_key("h1"),
            QueryValue::Log(Arc::new(vec![commit("aaaaaaa1", &big)])),
        );
        cache.insert(
            log_key("h2"),
            QueryValue::Log(Arc::new(vec![commit("aaaaaaa2", &big)])),
        );
        // The second insert pushed the total over 1000 bytes: h1 is gone.
        assert!(cache.get(&log_key("h1")).is_none());
        assert!(cache.get(&log_key("h2")).is_some());
        assert!(cache.stats().bytes <= 1_000);

        let huge = "y".repeat(2_000);
        cache.insert(
            log_key("h3"),
            QueryValue::Log(Arc::new(vec![commit("aaaaaaa3", &huge)])),
        );
        assert!(cache.get(&log_key("h3")).is_none());
        assert!(
            cache.get(&log_key("h2")).is_some(),
            "an oversized answer must not evict others"
        );
    }

    #[test]
    fn replacing_a_key_does_not_double_count_its_bytes() {
        let mut cache = QueryCache::new(4, 1 << 20);
        cache.insert(
            log_key("h1"),
            QueryValue::Log(Arc::new(vec![commit("a", "x")])),
        );
        let once = cache.stats().bytes;
        cache.insert(
            log_key("h1"),
            QueryValue::Log(Arc::new(vec![commit("a", "x")])),
        );
        assert_eq!(cache.stats().bytes, once);
        assert_eq!(cache.stats().entries, 1);
    }
}
