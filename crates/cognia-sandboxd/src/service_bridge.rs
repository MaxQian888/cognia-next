//! Bounded reverse service streams over a private Docker exec pipe. The peer
//! chooses no destination: the Host binds this pipe to one approved service.
use std::io;

pub const MAX_DATA: usize = 32 * 1024;
pub const MAX_CONNECTIONS: usize = 32;
pub const READY: u8 = 1;
pub const OPEN: u8 = 2;
pub const DATA: u8 = 3;
pub const HALF_CLOSE: u8 = 4;
pub const CLOSE: u8 = 5;
pub const RENEW: u8 = 6;
pub const EGRESS_READY: u8 = 7;
pub const EGRESS_RELEASE: u8 = 8;
pub const EGRESS_RELEASED: u8 = 9;
const HEADER: usize = 9;

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub id: u32,
    pub bytes: Vec<u8>,
}

pub fn encode(kind: u8, id: u32, bytes: &[u8]) -> io::Result<Vec<u8>> {
    validate(kind, id, bytes.len())?;
    let mut encoded = Vec::with_capacity(HEADER + bytes.len());
    encoded.push(kind);
    encoded.extend_from_slice(&id.to_be_bytes());
    encoded.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    encoded.extend_from_slice(bytes);
    Ok(encoded)
}

fn validate(kind: u8, id: u32, len: usize) -> io::Result<()> {
    let valid = match kind {
        READY => id == 0 && len == 2,
        EGRESS_READY | EGRESS_RELEASE | EGRESS_RELEASED => id == 0 && len > 0 && len <= 4096,
        RENEW => id == 0 && len == 0,
        OPEN | HALF_CLOSE | CLOSE => id != 0 && len == 0,
        DATA => id != 0 && len > 0 && len <= MAX_DATA,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid service frame",
        ))
    }
}

pub fn decode(buffer: &mut Vec<u8>) -> io::Result<Option<Frame>> {
    if buffer.len() < HEADER {
        return Ok(None);
    }
    let kind = buffer[0];
    let id = u32::from_be_bytes(buffer[1..5].try_into().unwrap());
    let len = u32::from_be_bytes(buffer[5..9].try_into().unwrap()) as usize;
    validate(kind, id, len)?;
    if buffer.len() < HEADER + len {
        return Ok(None);
    }
    let bytes = buffer[HEADER..HEADER + len].to_vec();
    buffer.drain(..HEADER + len);
    Ok(Some(Frame { kind, id, bytes }))
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        collections::{BTreeMap, VecDeque},
        fs::File,
        io::{Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        os::fd::{AsRawFd, OwnedFd},
        time::{Duration, Instant},
    };
    const MAX_PENDING: usize = 1024 * 1024;
    struct Connection {
        stream: TcpStream,
        pending: VecDeque<u8>,
        eof: bool,
        read_eof: bool,
    }

    fn nonblocking(fd: i32) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn enqueue(out: &mut VecDeque<u8>, kind: u8, id: u32, bytes: &[u8]) -> io::Result<()> {
        let frame = encode(kind, id, bytes)?;
        if out.len() + frame.len() > MAX_PENDING {
            return Err(io::Error::other("Service output backpressure limit"));
        }
        out.extend(frame);
        Ok(())
    }

    fn flush(writer: &mut impl Write, bytes: &mut VecDeque<u8>) -> io::Result<()> {
        while !bytes.is_empty() {
            match writer.write(bytes.as_slices().0) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(size) => {
                    bytes.drain(..size);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// All descriptors are nonblocking; one slow stream cannot retain a thread
    /// or defeat the lease deadline. Dropping this function closes every socket.
    pub fn run(input: OwnedFd, output: OwnedFd, lease: Duration) -> io::Result<()> {
        run_gateway(input, output, lease, None, None)
    }
    pub fn run_gateway(
        input: OwnedFd,
        output: OwnedFd,
        lease: Duration,
        nonce: Option<&str>,
        port: Option<u16>,
    ) -> io::Result<()> {
        run_inner(input, output, lease, nonce, port, None)
    }

    pub fn run_egress(
        input: OwnedFd,
        output: OwnedFd,
        lease: Duration,
        generation: &str,
        policy_digest: &str,
    ) -> io::Result<()> {
        run_inner(
            input,
            output,
            lease,
            None,
            None,
            Some((generation, policy_digest)),
        )
    }

    struct ProbeThread(Option<std::thread::JoinHandle<()>>);
    impl Drop for ProbeThread {
        fn drop(&mut self) {
            if let Some(thread) = self.0.take() {
                let _ = thread.join();
            }
        }
    }

    fn run_inner(
        input: OwnedFd,
        output: OwnedFd,
        lease: Duration,
        nonce: Option<&str>,
        port: Option<u16>,
        egress: Option<(&str, &str)>,
    ) -> io::Result<()> {
        if lease.is_zero() || lease > Duration::from_secs(60) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        nonblocking(input.as_raw_fd())?;
        nonblocking(output.as_raw_fd())?;
        let mut input = File::from(input);
        let mut output = File::from(output);
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port.unwrap_or(0)))?;
        listener.set_nonblocking(true)?;
        let _ready_file = nonce
            .map(|nonce| {
                crate::gateway_task::sandbox::publish(
                    nonce,
                    listener.local_addr().map_err(|e| e.to_string())?.port(),
                )
            })
            .transpose()
            .map_err(io::Error::other)?;
        let port = listener.local_addr()?.port();
        let ready = egress.map(|(generation, policy_digest)| crate::egress::Ready {
            version: crate::egress::VERSION,
            generation: generation.into(),
            policy_digest: policy_digest.into(),
            port,
        });
        let mut egress_lease = ready
            .as_ref()
            .map(|ready| crate::egress::LeaseGuard::new(ready.clone(), lease))
            .transpose()?;
        let (probe_result, _probe_thread) = if ready.is_some() {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            let thread = std::thread::spawn(move || {
                let _ = send.send(crate::egress::probe(port));
            });
            (Some(receive), ProbeThread(Some(thread)))
        } else {
            (None, ProbeThread(None))
        };
        let mut probe_complete = ready.is_none();
        let mut outgoing = VecDeque::new();
        if ready.is_none() {
            enqueue(&mut outgoing, READY, 0, &port.to_be_bytes())?;
        }
        let mut incoming = Vec::new();
        let mut connections: BTreeMap<u32, Connection> = BTreeMap::new();
        let mut next_id = 1u32;
        let mut deadline = Instant::now() + lease;
        let mut buffer = [0; MAX_DATA];
        loop {
            if !probe_complete {
                match probe_result.as_ref().expect("egress probe").try_recv() {
                    Ok(result) => {
                        result?;
                        probe_complete = true;
                        enqueue(
                            &mut outgoing,
                            EGRESS_READY,
                            0,
                            &serde_json::to_vec(ready.as_ref().expect("egress ready"))?,
                        )?;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => (),
                    Err(_) => return Err(io::Error::other("egress probe worker disconnected")),
                }
            }
            if Instant::now() >= deadline {
                return Ok(());
            }
            let mut fds = vec![
                libc::pollfd {
                    fd: input.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: output.as_raw_fd(),
                    events: if outgoing.is_empty() {
                        0
                    } else {
                        libc::POLLOUT
                    },
                    revents: 0,
                },
                libc::pollfd {
                    fd: if connections.len() < MAX_CONNECTIONS
                        && outgoing.len() + HEADER * MAX_CONNECTIONS < MAX_PENDING
                    {
                        listener.as_raw_fd()
                    } else {
                        -1
                    },
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let ids: Vec<_> = connections.keys().copied().collect();
            for id in &ids {
                let conn = &connections[id];
                fds.push(libc::pollfd {
                    fd: conn.stream.as_raw_fd(),
                    events: (if conn.read_eof || outgoing.len() + MAX_DATA + HEADER > MAX_PENDING {
                        0
                    } else {
                        libc::POLLIN
                    }) | (if conn.pending.is_empty() {
                        0
                    } else {
                        libc::POLLOUT
                    }),
                    revents: 0,
                });
                // poll reports HUP even with events=0. Ignore an idle or
                // backpressured descriptor until it has useful work again.
                let polled = fds.last_mut().expect("connection descriptor");
                if polled.events == 0 {
                    polled.fd = -1;
                }
            }
            let count = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 100) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if fds[1].revents & (libc::POLLHUP | libc::POLLERR) != 0 {
                return Ok(());
            }
            if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                match input.read(&mut buffer) {
                    Ok(0) => return Ok(()),
                    Ok(size) => {
                        incoming.extend_from_slice(&buffer[..size]);
                        while let Some(frame) = decode(&mut incoming)? {
                            if frame.kind == RENEW {
                                deadline = Instant::now() + lease;
                                if let Some(egress_lease) = &mut egress_lease {
                                    egress_lease.renew()?;
                                }
                                continue;
                            }
                            if frame.kind == EGRESS_RELEASE {
                                if !probe_complete {
                                    return Err(io::Error::other("egress release before probe"));
                                }
                                let release: crate::egress::Release =
                                    serde_json::from_slice(&frame.bytes)?;
                                egress_lease
                                    .as_mut()
                                    .ok_or_else(|| io::Error::other("not an egress bridge"))?
                                    .release(&release)?;
                                enqueue(
                                    &mut outgoing,
                                    EGRESS_RELEASED,
                                    0,
                                    &serde_json::to_vec(&release)?,
                                )?;
                                continue;
                            }
                            if !matches!(frame.kind, DATA | HALF_CLOSE | CLOSE) {
                                return Err(io::Error::other("Invalid Host service frame"));
                            }
                            if frame.kind == CLOSE {
                                connections.remove(&frame.id);
                                continue;
                            }
                            if let Some(conn) = connections.get_mut(&frame.id) {
                                if frame.kind == DATA {
                                    if conn.eof
                                        || conn.pending.len() + frame.bytes.len()
                                            > MAX_PENDING / MAX_CONNECTIONS * 8
                                    {
                                        connections.remove(&frame.id);
                                        enqueue(&mut outgoing, CLOSE, frame.id, &[])?;
                                    } else {
                                        conn.pending.extend(frame.bytes);
                                    }
                                } else {
                                    conn.eof = true;
                                }
                            }
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error),
                }
            }
            if fds[2].revents & libc::POLLIN != 0
                && outgoing.len() + HEADER * MAX_CONNECTIONS < MAX_PENDING
            {
                while let Ok((stream, _)) = listener.accept() {
                    if connections.len() >= MAX_CONNECTIONS {
                        drop(stream);
                        break;
                    }
                    let id = next_id;
                    next_id = next_id
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("Service stream ids exhausted"))?;
                    stream.set_nonblocking(true)?;
                    connections.insert(
                        id,
                        Connection {
                            stream,
                            pending: VecDeque::new(),
                            eof: false,
                            read_eof: false,
                        },
                    );
                    enqueue(&mut outgoing, OPEN, id, &[])?;
                }
            }
            for (offset, id) in ids.iter().enumerate() {
                let Some(conn) = connections.get_mut(id) else {
                    continue;
                };
                let events = fds[offset + 3].revents;
                let mut closed = events & libc::POLLERR != 0;
                if !conn.read_eof
                    && outgoing.len() + MAX_DATA + HEADER <= MAX_PENDING
                    && events & (libc::POLLIN | libc::POLLHUP) != 0
                {
                    match conn.stream.read(&mut buffer) {
                        Ok(0) => {
                            conn.read_eof = true;
                            enqueue(&mut outgoing, HALF_CLOSE, *id, &[])?;
                        }
                        Ok(size) => enqueue(&mut outgoing, DATA, *id, &buffer[..size])?,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                        Err(_) => closed = true,
                    }
                }
                if flush(&mut conn.stream, &mut conn.pending).is_err() {
                    closed = true;
                }
                if conn.eof && conn.pending.is_empty() {
                    let _ = conn.stream.shutdown(Shutdown::Write);
                    if conn.read_eof {
                        closed = true;
                    }
                }
                if closed {
                    connections.remove(id);
                    enqueue(&mut outgoing, CLOSE, *id, &[])?;
                }
            }
            flush(&mut output, &mut outgoing)?;
        }
    }
}
#[cfg(unix)]
pub use unix::{run, run_egress, run_gateway};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn egress_frames_are_versioned_bounded_and_distinct_from_services() {
        let release = crate::egress::Release {
            version: crate::egress::VERSION,
            generation: "fresh".into(),
        };
        let payload = serde_json::to_vec(&release).unwrap();
        for kind in [EGRESS_READY, EGRESS_RELEASE, EGRESS_RELEASED] {
            let mut encoded = encode(kind, 0, &payload).unwrap();
            assert_eq!(decode(&mut encoded).unwrap().unwrap().bytes, payload);
            assert!(encode(kind, 1, &payload).is_err());
            assert!(encode(kind, 0, &vec![0; 4097]).is_err());
        }
        assert!(encode(READY, 0, &payload).is_err());
        assert!(encode(EGRESS_READY, 0, &[]).is_err());
    }

    #[test]
    fn frames_are_fragment_safe_and_reject_unbounded_or_unknown_messages() {
        let wire = encode(DATA, 7, b"payload").unwrap();
        let mut bytes = wire[..6].to_vec();
        assert!(decode(&mut bytes).unwrap().is_none());
        bytes.extend_from_slice(&wire[6..]);
        assert_eq!(decode(&mut bytes).unwrap().unwrap().bytes, b"payload");
        assert!(encode(DATA, 1, &vec![0; MAX_DATA + 1]).is_err());
        assert!(encode(99, 1, &[]).is_err());
        assert!(encode(OPEN, 0, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn loopback_binary_stream_half_close_and_lease_expiry() {
        use std::{
            io::{Read, Write},
            net::{Shutdown, TcpStream},
            os::unix::net::UnixStream,
            time::Duration,
        };
        let (mut host, helper) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let output = helper.try_clone().unwrap();
        let worker = std::thread::spawn(move || {
            run(helper.into(), output.into(), Duration::from_millis(500)).unwrap()
        });
        fn read(stream: &mut UnixStream) -> Frame {
            let mut head = [0; HEADER];
            stream.read_exact(&mut head).unwrap();
            let length = u32::from_be_bytes(head[5..9].try_into().unwrap()) as usize;
            let mut all = head.to_vec();
            all.resize(HEADER + length, 0);
            stream.read_exact(&mut all[HEADER..]).unwrap();
            decode(&mut all).unwrap().unwrap()
        }
        let ready = read(&mut host);
        assert_eq!(ready.kind, READY);
        let port = u16::from_be_bytes(ready.bytes.try_into().unwrap());
        let mut client = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let open = read(&mut host);
        assert_eq!(open.kind, OPEN);
        client.write_all(b"hello\0binary").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        assert_eq!(read(&mut host).bytes, b"hello\0binary");
        assert_eq!(read(&mut host).kind, HALF_CLOSE);
        host.write_all(&encode(DATA, open.id, b"response").unwrap())
            .unwrap();
        host.write_all(&encode(HALF_CLOSE, open.id, &[]).unwrap())
            .unwrap();
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"response");
        worker.join().unwrap();
        assert!(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
    }
}
