//! A scripted [`RemoteShell`] for the installer's own tests.
//!
//! Exact argv lines answer from a queue (the last answer repeats), handlers
//! answer whole command families from the fake machine's state, and uploads
//! land in an in-memory file table that `stat` and the digest check read.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use async_trait::async_trait;
use parking_lot::Mutex;
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;

use crate::shell::{
    ExecOutput, ExecRequest, RemoteOutcome, RemoteShell, RemoteStat, ShellError, UploadSource,
};

type Handler =
    Box<dyn Fn(&ExecRequest, &mut FakeMachine) -> Option<RemoteOutcome<ExecOutput>> + Send>;

/// What the fake machine holds between requests.
#[derive(Default)]
pub struct FakeMachine {
    pub files: BTreeMap<String, Vec<u8>>,
    pub dirs: BTreeSet<String>,
    /// Arbitrary state handlers share (an installed version, a running flag).
    pub state: HashMap<String, String>,
}

#[derive(Default)]
pub struct FakeShell {
    scripted: Mutex<HashMap<Vec<String>, VecDeque<RemoteOutcome<ExecOutput>>>>,
    handlers: Mutex<Vec<Handler>>,
    pub machine: Mutex<FakeMachine>,
    /// Every exec, in order.
    pub log: Mutex<Vec<ExecRequest>>,
    /// Uploads that should fail the next time, by path.
    pub failing_uploads: Mutex<HashMap<String, RemoteOutcome<()>>>,
}

pub fn output(exit: i32, stdout: &str) -> RemoteOutcome<ExecOutput> {
    RemoteOutcome::Completed(ExecOutput {
        exit_code: Some(exit),
        stdout: stdout.to_owned(),
        stderr: String::new(),
        truncated: false,
    })
}

impl FakeShell {
    pub fn new() -> Self {
        Self::default()
    }

    /// The ADR-0224 box: Ubuntu 22.04, glibc 2.35, lingering off.
    pub fn linux_ubuntu_2204() -> Self {
        let shell = Self::new();
        shell.answer(&["uname", "-s"], 0, "Linux\n");
        shell.answer(&["uname", "-m"], 0, "x86_64\n");
        shell.answer(&["uname", "-n"], 0, "VM-0-8-ubuntu\n");
        shell.answer(&["id", "-un"], 0, "ubuntu\n");
        shell.answer(&["printenv", "HOME"], 0, "/home/ubuntu\n");
        shell.answer(&["cat", "/proc/1/comm"], 0, "systemd\n");
        shell.answer(
            &[
                "loginctl",
                "show-user",
                "ubuntu",
                "--property=Linger",
                "--value",
            ],
            0,
            "no\n",
        );
        shell.answer(&["getconf", "GNU_LIBC_VERSION"], 0, "glibc 2.35\n");
        shell.answer(
            &["df", "-Pk", "/home/ubuntu"],
            0,
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 82045336 29590364 52428800 37% /\n",
        );
        shell
    }

    fn key(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|part| (*part).to_owned()).collect()
    }

    pub fn script(&self, argv: &[&str], outcome: RemoteOutcome<ExecOutput>) {
        self.scripted
            .lock()
            .entry(Self::key(argv))
            .or_default()
            .push_back(outcome);
    }

    /// Replace every queued answer for `argv` with `outcome`.
    pub fn rescript(&self, argv: &[&str], outcome: RemoteOutcome<ExecOutput>) {
        let mut scripted = self.scripted.lock();
        let queue = scripted.entry(Self::key(argv)).or_default();
        queue.clear();
        queue.push_back(outcome);
    }

    pub fn answer(&self, argv: &[&str], exit: i32, stdout: &str) {
        self.script(argv, output(exit, stdout));
    }

    pub fn unknown(&self, argv: &[&str]) {
        self.rescript(argv, RemoteOutcome::Unknown("the channel dropped".into()));
    }

    /// Answer every exec `handler` returns `Some` for, from the machine state.
    pub fn handle(
        &self,
        handler: impl Fn(&ExecRequest, &mut FakeMachine) -> Option<RemoteOutcome<ExecOutput>>
            + Send
            + 'static,
    ) {
        self.handlers.lock().push(Box::new(handler));
    }

    /// The argv of every exec so far.
    pub fn commands(&self) -> Vec<Vec<String>> {
        self.log
            .lock()
            .iter()
            .map(|request| request.argv.clone())
            .collect()
    }
}

#[async_trait]
impl RemoteShell for FakeShell {
    async fn stat(&self, path: &str) -> RemoteOutcome<Option<RemoteStat>> {
        let machine = self.machine.lock();
        if machine.dirs.contains(path) {
            return RemoteOutcome::Completed(Some(RemoteStat {
                is_dir: true,
                size: 0,
            }));
        }
        RemoteOutcome::Completed(machine.files.get(path).map(|bytes| RemoteStat {
            is_dir: false,
            size: bytes.len() as u64,
        }))
    }

    async fn mkdirp(&self, path: &str) -> RemoteOutcome<()> {
        let mut machine = self.machine.lock();
        let mut prefix = String::new();
        for part in path.split('/').filter(|part| !part.is_empty()) {
            prefix.push('/');
            prefix.push_str(part);
            machine.dirs.insert(prefix.clone());
        }
        RemoteOutcome::Completed(())
    }

    async fn upload(&self, path: &str, mut source: UploadSource) -> RemoteOutcome<()> {
        if let Some(outcome) = self.failing_uploads.lock().remove(path) {
            return outcome;
        }
        let mut bytes = Vec::new();
        if let Err(error) = source.reader.read_to_end(&mut bytes).await {
            return RemoteOutcome::NotStarted(ShellError::Fault(error.to_string()));
        }
        if bytes.len() as u64 != source.len {
            return RemoteOutcome::Unknown("the stream length did not match".into());
        }
        self.machine.lock().files.insert(path.to_owned(), bytes);
        RemoteOutcome::Completed(())
    }

    async fn exec(&self, request: ExecRequest) -> RemoteOutcome<ExecOutput> {
        self.log.lock().push(request.clone());
        {
            let mut scripted = self.scripted.lock();
            if let Some(queue) = scripted.get_mut(&request.argv) {
                let outcome = if queue.len() > 1 {
                    queue.pop_front()
                } else {
                    queue.front().cloned()
                };
                if let Some(outcome) = outcome {
                    return outcome;
                }
            }
        }
        let handlers = self.handlers.lock();
        let mut machine = self.machine.lock();
        for handler in handlers.iter() {
            if let Some(outcome) = handler(&request, &mut machine) {
                return outcome;
            }
        }
        // An unknown program on a real machine: the shell says not found.
        output(127, "")
    }
}

/// The hex SHA-256 the fake `sha256sum` prints.
pub fn hex_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scripted_answers_play_in_order_and_the_last_one_repeats() {
        let shell = FakeShell::new();
        shell.answer(&["x"], 1, "first");
        shell.answer(&["x"], 0, "second");
        let run = || shell.exec(ExecRequest::new(["x"], std::time::Duration::from_secs(1)));
        let RemoteOutcome::Completed(first) = run().await else {
            panic!()
        };
        assert_eq!(first.stdout, "first");
        for _ in 0..2 {
            let RemoteOutcome::Completed(again) = run().await else {
                panic!()
            };
            assert_eq!(again.stdout, "second");
        }
        let RemoteOutcome::Completed(missing) = shell
            .exec(ExecRequest::new(
                ["nope"],
                std::time::Duration::from_secs(1),
            ))
            .await
        else {
            panic!()
        };
        assert_eq!(missing.exit_code, Some(127));
        assert_eq!(shell.commands().len(), 4);
    }

    #[tokio::test]
    async fn uploads_land_in_the_file_table_and_check_their_length() {
        let shell = FakeShell::new();
        let ok = UploadSource {
            len: 3,
            sha256: hex_sha256(b"abc"),
            reader: Box::new(&b"abc"[..]),
        };
        assert_eq!(shell.upload("/a", ok).await, RemoteOutcome::Completed(()));
        assert_eq!(
            shell.stat("/a").await,
            RemoteOutcome::Completed(Some(RemoteStat {
                is_dir: false,
                size: 3
            }))
        );
        let short = UploadSource {
            len: 9,
            sha256: String::new(),
            reader: Box::new(&b"abc"[..]),
        };
        assert!(matches!(
            shell.upload("/b", short).await,
            RemoteOutcome::Unknown(_)
        ));
        shell.mkdirp("/x/y").await;
        assert!(shell.machine.lock().dirs.contains("/x"));
    }
}
