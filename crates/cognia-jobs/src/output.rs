//! Job output storage: an in-memory ring for the live tail, backed by an
//! append-only on-disk log for history.
//!
//! This replaces the sidecar's previous `entry.buffer += s; buffer.slice(drop)`
//! ring, which copied the entire 256 KB window on *every* chunk once saturated
//! — tens of MB/s of pure memcpy on a chatty build. Here the ring holds
//! `Bytes` chunks and evicts whole chunks from the front, so appending is O(1)
//! amortised and never copies retained data.
//!
//! Addressing is by absolute byte offset rather than a single consume-once
//! cursor. That is what makes "wait until the output matches /ready/" possible:
//! a non-matching read no longer destroys the bytes it skipped.
//!
//! On-disk history is two segments (`<id>.log` current, `<id>.log.1` previous).
//! Rotation is a rename, so it is O(1); total on-disk stays under twice the
//! per-job cap and anything older is honestly reported as gone via
//! [`JobOutput::log_start_offset`].

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bytes::Bytes;

use crate::limits::{
    truncation_marker, MAX_LOG_BYTES_PER_JOB, MAX_OUTPUT_BYTES_PER_SEC, RING_CAPACITY_BYTES,
};
use crate::types::JobOutputSlice;

/// Sliding one-second window rate limiter.
///
/// Pure with respect to time — the caller passes `now`, so tests exercise
/// window rollover without sleeping.
#[derive(Debug)]
pub struct RateLimiter {
    window_start: Instant,
    window_bytes: u64,
    limit_per_sec: u64,
}

impl RateLimiter {
    pub fn new(now: Instant) -> Self {
        Self::with_limit(now, MAX_OUTPUT_BYTES_PER_SEC)
    }

    pub fn with_limit(now: Instant, limit_per_sec: u64) -> Self {
        Self {
            window_start: now,
            window_bytes: 0,
            limit_per_sec,
        }
    }

    /// How many of `len` bytes may be accepted right now. The remainder is the
    /// caller's responsibility to count as dropped.
    pub fn admit(&mut self, len: usize, now: Instant) -> usize {
        if now.duration_since(self.window_start) >= Duration::from_secs(1) {
            self.window_start = now;
            self.window_bytes = 0;
        }
        let remaining = self.limit_per_sec.saturating_sub(self.window_bytes);
        let accepted = (len as u64).min(remaining);
        self.window_bytes += accepted;
        accepted as usize
    }
}

/// Per-job output store. Not `Sync` on its own — the supervisor holds it behind
/// a mutex, and every method here is short and non-blocking on the hot path.
#[derive(Debug)]
pub struct JobOutput {
    ring: VecDeque<Bytes>,
    ring_bytes: usize,
    ring_capacity: usize,
    /// Absolute offset of the first byte currently held in the ring.
    ring_start_offset: u64,
    /// High-water mark: total bytes ever accepted (excludes dropped bytes).
    total_bytes: u64,
    dropped_bytes: u64,

    current_path: PathBuf,
    previous_path: PathBuf,
    current_file: Option<File>,
    /// Absolute offset at which the current segment begins.
    current_segment_start: u64,
    /// Absolute offset at which the previous segment begins, if one exists.
    previous_segment_start: Option<u64>,
    segment_cap: u64,

    limiter: RateLimiter,
    /// True while the limiter is shedding inside the current window, so the
    /// truncation marker is written once per burst rather than per chunk.
    shedding: bool,
}

impl JobOutput {
    /// Open the log for `job_id` under `dir`, adopting whatever is already on
    /// disk.
    ///
    /// Adoption is what makes a finished job readable after its live state is
    /// gone — including across an app restart, which is the whole point of
    /// persisting the log. For a brand-new job the segments do not exist, the
    /// adopted lengths are zero, and this is an ordinary create.
    ///
    /// Note that offsets are rebased onto the *surviving* segments: bytes that
    /// had already rotated off disk in a previous lifetime are gone, and
    /// pretending otherwise would hand out offsets that can never be read.
    pub fn open(dir: &Path, job_id: &str, now: Instant) -> std::io::Result<Self> {
        fs::create_dir_all(dir)?;
        let current_path = dir.join(format!("{job_id}.log"));
        let previous_path = dir.join(format!("{job_id}.log.1"));
        let current_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&current_path)?;

        let len_of = |p: &PathBuf| fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let previous_len = len_of(&previous_path);
        let current_len = len_of(&current_path);
        let (previous_segment_start, current_segment_start) = if previous_len > 0 {
            (Some(0), previous_len)
        } else {
            (None, 0)
        };

        Ok(Self {
            ring: VecDeque::new(),
            ring_bytes: 0,
            ring_capacity: RING_CAPACITY_BYTES,
            // An empty ring sits at the high-water mark: everything already on
            // disk is served from disk, and new appends extend from here.
            ring_start_offset: current_segment_start + current_len,
            total_bytes: current_segment_start + current_len,
            dropped_bytes: 0,
            current_path,
            previous_path,
            current_file: Some(current_file),
            current_segment_start,
            previous_segment_start,
            segment_cap: MAX_LOG_BYTES_PER_JOB / 2,
            limiter: RateLimiter::new(now),
            shedding: false,
        })
    }

    /// Test seam: smaller ring and segment cap so rotation is reachable.
    #[cfg(test)]
    pub fn open_with_limits(
        dir: &Path,
        job_id: &str,
        now: Instant,
        ring_capacity: usize,
        segment_cap: u64,
        limit_per_sec: u64,
    ) -> std::io::Result<Self> {
        let mut out = Self::open(dir, job_id, now)?;
        out.ring_capacity = ring_capacity;
        out.segment_cap = segment_cap;
        out.limiter = RateLimiter::with_limit(now, limit_per_sec);
        Ok(out)
    }

    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    pub fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }

    /// Oldest offset still readable. Anything below this has rotated off disk.
    pub fn log_start_offset(&self) -> u64 {
        self.previous_segment_start
            .unwrap_or(self.current_segment_start)
    }

    /// Append a chunk of raw output. Returns the number of bytes accepted.
    ///
    /// Bytes beyond the rate ceiling are dropped and accounted; a marker is
    /// written into the log once per shedding burst so a reader can never
    /// mistake a gap for silence.
    pub fn append(&mut self, chunk: &[u8], now: Instant) -> usize {
        if chunk.is_empty() {
            return 0;
        }
        let accepted = self.limiter.admit(chunk.len(), now);
        let dropped = chunk.len() - accepted;

        if dropped > 0 {
            self.dropped_bytes += dropped as u64;
            if !self.shedding {
                self.shedding = true;
                // Recorded through the same path as real output so it lands in
                // both the ring and the log, at a real offset.
                let marker = truncation_marker(dropped as u64).into_bytes();
                self.write_accepted(&marker);
            }
        } else {
            self.shedding = false;
        }

        if accepted > 0 {
            self.write_accepted(&chunk[..accepted]);
        }
        accepted
    }

    /// Push bytes that have already cleared the rate limiter into ring + disk.
    fn write_accepted(&mut self, bytes: &[u8]) {
        self.total_bytes += bytes.len() as u64;

        // Disk first: the log is the durable record, the ring is a cache.
        if let Some(file) = self.current_file.as_mut() {
            if file.write_all(bytes).is_err() {
                // A failed log write must not take the job down; the ring still
                // serves the live tail.
                self.current_file = None;
            }
        }
        if self.current_file.is_some()
            && self.total_bytes - self.current_segment_start >= self.segment_cap
        {
            self.rotate();
        }

        // Ring: store the chunk, then evict whole chunks from the front.
        self.ring.push_back(Bytes::copy_from_slice(bytes));
        self.ring_bytes += bytes.len();
        while self.ring_bytes > self.ring_capacity && self.ring.len() > 1 {
            if let Some(front) = self.ring.pop_front() {
                self.ring_bytes -= front.len();
                self.ring_start_offset += front.len() as u64;
            }
        }
    }

    /// Rename the current segment to the previous slot and start a fresh one.
    /// O(1) — no data is copied.
    fn rotate(&mut self) {
        if let Some(mut file) = self.current_file.take() {
            let _ = file.flush();
        }
        let _ = fs::remove_file(&self.previous_path);
        if fs::rename(&self.current_path, &self.previous_path).is_err() {
            // Rotation failed — keep appending to the current segment rather
            // than losing the stream. It will simply exceed the soft cap.
            self.current_file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.current_path)
                .ok();
            return;
        }
        self.previous_segment_start = Some(self.current_segment_start);
        self.current_segment_start = self.total_bytes;
        self.current_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.current_path)
            .ok();
    }

    /// Read up to `max_bytes` starting at absolute offset `from`.
    ///
    /// Offsets below [`Self::log_start_offset`] are clamped up — those bytes
    /// have rotated away. Reads never consume: the same range can be read
    /// repeatedly, which is what lets a pattern match re-scan.
    pub fn read(&mut self, from: u64, max_bytes: usize) -> JobOutputSlice {
        let start = from.max(self.log_start_offset()).min(self.total_bytes);
        let available = self.total_bytes - start;
        let want = (max_bytes as u64).min(available) as usize;

        let bytes = if want == 0 {
            Vec::new()
        } else if start >= self.ring_start_offset {
            self.read_from_ring(start, want)
        } else {
            self.read_from_disk(start, want)
        };

        let next_offset = start + bytes.len() as u64;
        JobOutputSlice {
            from_offset: start,
            next_offset,
            data: String::from_utf8_lossy(&bytes).into_owned(),
            // Filled in by the supervisor, which owns lifecycle state.
            status: crate::types::JobStatus::Running,
            exit_code: None,
            has_more: next_offset < self.total_bytes,
        }
    }

    fn read_from_ring(&self, start: u64, want: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(want);
        let mut cursor = self.ring_start_offset;
        for chunk in &self.ring {
            let chunk_end = cursor + chunk.len() as u64;
            if chunk_end > start {
                let skip = start.saturating_sub(cursor) as usize;
                let take = (want - out.len()).min(chunk.len() - skip);
                out.extend_from_slice(&chunk[skip..skip + take]);
                if out.len() >= want {
                    break;
                }
            }
            cursor = chunk_end;
        }
        out
    }

    /// Serve a historical range from disk. Reads at most one segment per call;
    /// the caller pages via `next_offset`.
    fn read_from_disk(&self, start: u64, want: usize) -> Vec<u8> {
        let (path, segment_start, segment_end) = match self.previous_segment_start {
            Some(prev_start) if start < self.current_segment_start => {
                (&self.previous_path, prev_start, self.current_segment_start)
            }
            _ => (
                &self.current_path,
                self.current_segment_start,
                self.total_bytes,
            ),
        };
        let capped = want.min((segment_end - start) as usize);
        if capped == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u8; capped];
        let read = File::open(path)
            .and_then(|mut f| {
                f.seek(SeekFrom::Start(start - segment_start))?;
                read_full(&mut f, &mut buf)
            })
            .unwrap_or(0);
        buf.truncate(read);
        buf
    }

    /// Scan the readable tail for `re`, returning the absolute offset just past
    /// the first match at or after `from`. Non-destructive.
    pub fn find_match(&mut self, re: &regex::Regex, from: u64) -> Option<u64> {
        let start = from.max(self.log_start_offset());
        let slice = self.read(start, self.ring_capacity);
        re.find(&slice.data)
            .map(|m| slice.from_offset + m.end() as u64)
    }

    /// Delete both segments. Called when a job's history is evicted.
    pub fn remove_files(&mut self) {
        self.current_file = None;
        let _ = fs::remove_file(&self.current_path);
        let _ = fs::remove_file(&self.previous_path);
    }

    /// Bytes currently on disk across both segments.
    pub fn disk_bytes(&self) -> u64 {
        let one = |p: &PathBuf| fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        one(&self.current_path) + one(&self.previous_path)
    }

    pub fn flush(&mut self) {
        if let Some(file) = self.current_file.as_mut() {
            let _ = file.flush();
        }
    }
}

/// `read` until the buffer is full or EOF. `Read::read` may return short.
fn read_full(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match f.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn out(dir: &TempDir, now: Instant) -> JobOutput {
        // 64-byte ring, 128-byte segments, 1 KB/s — small enough that eviction,
        // rotation, and shedding are all reachable in a unit test.
        JobOutput::open_with_limits(dir.path(), "job-1", now, 64, 128, 1024).unwrap()
    }

    #[test]
    fn appends_are_readable_from_offset_zero() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        o.append(b"hello ", now);
        o.append(b"world", now);

        let slice = o.read(0, 1024);
        assert_eq!(slice.data, "hello world");
        assert_eq!(slice.from_offset, 0);
        assert_eq!(slice.next_offset, 11);
        assert!(!slice.has_more);
    }

    #[test]
    fn reads_are_non_destructive_so_the_same_range_re_reads() {
        // This is the property the old cursor-only registry lacked, and the
        // reason "wait for a pattern" could silently eat output.
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        o.append(b"abcdef", now);

        assert_eq!(o.read(0, 1024).data, "abcdef");
        assert_eq!(o.read(0, 1024).data, "abcdef");
        assert_eq!(o.read(3, 1024).data, "def");
    }

    #[test]
    fn max_bytes_pages_without_losing_the_remainder() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        o.append(b"0123456789", now);

        let first = o.read(0, 4);
        assert_eq!(first.data, "0123");
        assert!(first.has_more);
        let second = o.read(first.next_offset, 4);
        assert_eq!(second.data, "4567");
        let third = o.read(second.next_offset, 4);
        assert_eq!(third.data, "89");
        assert!(!third.has_more);
    }

    #[test]
    fn ring_evicts_whole_chunks_without_copying_retained_data() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        // 10 chunks of 20 bytes = 200 bytes through a 64-byte ring.
        for i in 0..10u8 {
            o.append(&[b'a' + i; 20], now);
        }
        assert_eq!(o.total_bytes(), 200);
        // The ring holds only the tail; the start offset advanced past evicted
        // chunks in whole-chunk steps (multiples of 20).
        assert!(o.ring_start_offset > 0);
        assert_eq!(o.ring_start_offset % 20, 0);
        assert!(o.ring_bytes <= 64 + 20);
    }

    #[test]
    fn history_evicted_from_the_ring_is_still_served_from_disk() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        o.append(b"HEAD-MARKER-", now);
        for _ in 0..10 {
            o.append(&[b'x'; 20], now);
        }
        // Offset 0 is long gone from the 64-byte ring but must still read back.
        let slice = o.read(0, 12);
        assert_eq!(slice.data, "HEAD-MARKER-");
    }

    #[test]
    fn rotation_keeps_the_recent_tail_and_reports_the_lost_head() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        // Segment cap is 128 bytes; write enough to rotate twice.
        for _ in 0..30 {
            o.append(&[b'z'; 20], now);
        }
        assert!(o.log_start_offset() > 0, "head should have rotated away");
        // The tail is intact.
        let tail = o.read(o.total_bytes() - 10, 10);
        assert_eq!(tail.data, "zzzzzzzzzz");
        // A read below the start offset clamps up rather than lying.
        let clamped = o.read(0, 10);
        assert_eq!(clamped.from_offset, o.log_start_offset());
    }

    #[test]
    fn rate_limiter_admits_up_to_the_ceiling_then_sheds_within_a_window() {
        let now = Instant::now();
        let mut rl = RateLimiter::with_limit(now, 100);
        assert_eq!(rl.admit(60, now), 60);
        assert_eq!(rl.admit(60, now), 40); // only 40 left in this window
        assert_eq!(rl.admit(10, now), 0);
    }

    #[test]
    fn rate_limiter_window_rolls_over_after_a_second() {
        let now = Instant::now();
        let mut rl = RateLimiter::with_limit(now, 100);
        assert_eq!(rl.admit(100, now), 100);
        assert_eq!(rl.admit(50, now), 0);
        let later = now + Duration::from_millis(1_001);
        assert_eq!(rl.admit(50, later), 50);
    }

    #[test]
    fn shedding_writes_one_truncation_marker_per_burst_and_counts_drops() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        // 1 KB/s limit; push 3 KB in one instant.
        let mut o = out(&dir, now);
        o.append(&[b'q'; 3072], now);
        assert_eq!(o.dropped_bytes(), 3072 - 1024);

        let all = o.read(o.log_start_offset(), 1 << 20).data;
        assert!(
            all.contains("output truncated"),
            "log must record the gap explicitly, got: {all:?}"
        );
        // A second shedding append inside the same burst does not add a second
        // marker.
        o.append(&[b'q'; 512], now);
        let all = o.read(o.log_start_offset(), 1 << 20).data;
        assert_eq!(all.matches("output truncated").count(), 1);
    }

    #[test]
    fn find_match_returns_the_offset_past_the_first_hit_and_does_not_consume() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        o.append(b"booting...\nserver ready on 3000\n", now);

        let re = regex::Regex::new(r"ready").unwrap();
        let hit = o.find_match(&re, 0).expect("should match");
        assert_eq!(hit, "booting...\nserver ".len() as u64 + 5);
        // Non-destructive: matching again from 0 still finds it.
        assert!(o.find_match(&re, 0).is_some());
    }

    #[test]
    fn find_match_returns_none_when_the_pattern_is_absent() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        o.append(b"still compiling", now);
        let re = regex::Regex::new(r"ready").unwrap();
        assert!(o.find_match(&re, 0).is_none());
        // And the bytes survive the failed match — the old implementation lost
        // them here.
        assert_eq!(o.read(0, 1024).data, "still compiling");
    }

    #[test]
    fn empty_append_is_a_no_op() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        assert_eq!(o.append(b"", now), 0);
        assert_eq!(o.total_bytes(), 0);
    }

    #[test]
    fn reading_past_the_end_returns_empty_not_an_error() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        o.append(b"abc", now);
        let slice = o.read(999, 100);
        assert_eq!(slice.data, "");
        assert_eq!(slice.from_offset, 3);
        assert!(!slice.has_more);
    }

    #[test]
    fn reopening_adopts_the_existing_log_so_history_survives_a_restart() {
        // Regression: a fresh `open` used to start at offset 0 with no
        // knowledge of the file, so a finished job's log read back empty once
        // its live state was dropped — and after an app restart, always.
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        {
            let mut o = out(&dir, now);
            o.append(b"line-from-a-previous-lifetime", now);
            o.flush();
        }

        let mut reopened = out(&dir, now);
        assert_eq!(
            reopened.total_bytes(),
            "line-from-a-previous-lifetime".len() as u64
        );
        let slice = reopened.read(0, 1024);
        assert_eq!(slice.data, "line-from-a-previous-lifetime");
    }

    #[test]
    fn reopening_appends_after_the_adopted_content_rather_than_over_it() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        {
            let mut o = out(&dir, now);
            o.append(b"first ", now);
            o.flush();
        }
        let mut reopened = out(&dir, now);
        reopened.append(b"second", now);

        assert_eq!(reopened.read(0, 1024).data, "first second");
    }

    #[test]
    fn remove_files_deletes_both_segments() {
        let dir = TempDir::new().unwrap();
        let now = Instant::now();
        let mut o = out(&dir, now);
        for _ in 0..20 {
            o.append(&[b'k'; 20], now);
        }
        assert!(o.disk_bytes() > 0);
        o.remove_files();
        assert_eq!(o.disk_bytes(), 0);
    }
}
