//! `git blame --porcelain` (system git) → per-line authorship.
//!
//! Porcelain output emits each commit's metadata header (author / time /
//! summary) only the FIRST time the commit is seen; later lines of the same
//! commit carry just the SHA header + the `\t`-prefixed content. We cache
//! per-commit metadata so every line resolves its author regardless of order.

use std::collections::HashMap;

use super::error::Result;
use super::exec;
use super::types::GitBlameLine;

/// Blame `path`. With `rev = None` blames the working tree; with a rev (commit,
/// branch, or tag) blames the file as of that revision (commit-pinned blame).
pub async fn blame(repo_path: &str, path: &str, rev: Option<&str>) -> Result<Vec<GitBlameLine>> {
    let mut args: Vec<&str> = vec!["blame", "--porcelain"];
    if let Some(r) = rev {
        args.push(r);
    }
    args.push("--");
    args.push(path);
    let out = exec::capture(&std::path::PathBuf::from(repo_path), args).await?;
    Ok(parse_porcelain(&out))
}

#[derive(Default, Clone)]
struct CommitMeta {
    author: String,
    time_secs: i64,
    summary: String,
}

fn is_sha_header(line: &str) -> Option<(String, u32)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    let sha = parts[0];
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    // parts[1] = original line, parts[2] = final line (1-based).
    let final_line = parts[2].parse::<u32>().ok()?;
    parts[1].parse::<u32>().ok()?;
    Some((sha.to_string(), final_line))
}

fn parse_porcelain(text: &str) -> Vec<GitBlameLine> {
    let mut out: Vec<GitBlameLine> = Vec::new();
    let mut meta: HashMap<String, CommitMeta> = HashMap::new();

    let mut cur_hash = String::new();
    let mut cur_line = 0u32;
    let mut pending = CommitMeta::default();
    let mut have_pending = false;

    for line in text.lines() {
        if let Some(stripped) = line.strip_prefix('\t') {
            // Content line — flush any freshly-parsed header into the cache.
            if have_pending {
                meta.insert(cur_hash.clone(), pending.clone());
                pending = CommitMeta::default();
                have_pending = false;
            }
            let m = meta.get(&cur_hash).cloned().unwrap_or_default();
            let short_hash: String = cur_hash.chars().take(7).collect();
            out.push(GitBlameLine {
                line_number: cur_line,
                commit_hash: cur_hash.clone(),
                short_hash,
                author_name: m.author,
                authored_at_ms: m.time_secs.saturating_mul(1_000),
                summary: m.summary,
                content: stripped.to_string(),
            });
            continue;
        }

        if let Some((sha, final_line)) = is_sha_header(line) {
            cur_hash = sha;
            cur_line = final_line;
            pending = CommitMeta::default();
            have_pending = false;
            continue;
        }

        if let Some(rest) = line.strip_prefix("author ") {
            pending.author = rest.to_string();
            have_pending = true;
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            pending.time_secs = rest.trim().parse().unwrap_or(0);
            have_pending = true;
        } else if let Some(rest) = line.strip_prefix("summary ") {
            pending.summary = rest.to_string();
            have_pending = true;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two lines from commit A, one from commit B; B's header omits nothing
    // because it's first seen, A's second line carries no header (cached).
    const PORCELAIN: &str = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
author Alice
author-mail <alice@e.com>
author-time 1000
author-tz +0000
summary first commit
filename a.txt
\tline one
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2
\tline two
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1
author Bob
author-mail <bob@e.com>
author-time 2000
author-tz +0000
summary second commit
filename a.txt
\tline three
";

    #[test]
    fn parses_each_line_with_cached_author() {
        let lines = parse_porcelain(PORCELAIN);
        assert_eq!(lines.len(), 3);

        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[0].author_name, "Alice");
        assert_eq!(lines[0].summary, "first commit");
        assert_eq!(lines[0].authored_at_ms, 1_000_000);
        assert_eq!(lines[0].content, "line one");
        assert_eq!(lines[0].short_hash, "aaaaaaa");

        // Second line reuses commit A's cached metadata (no header repeated).
        assert_eq!(lines[1].line_number, 2);
        assert_eq!(lines[1].author_name, "Alice");
        assert_eq!(lines[1].content, "line two");

        assert_eq!(lines[2].line_number, 3);
        assert_eq!(lines[2].author_name, "Bob");
        assert_eq!(lines[2].content, "line three");
        assert_eq!(lines[2].authored_at_ms, 2_000_000);
    }

    #[test]
    fn ignores_garbage_and_empty() {
        assert!(parse_porcelain("").is_empty());
        assert!(parse_porcelain("not a blame\njust text").is_empty());
    }

    #[test]
    fn detects_sha_header() {
        assert!(is_sha_header("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2").is_some());
        assert!(is_sha_header("author Alice").is_none());
        assert!(is_sha_header("summary x").is_none());
    }
}
