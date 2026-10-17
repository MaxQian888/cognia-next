//! Fixed-destination, bounded, full-duplex transport; it never parses requests.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub(crate) const SOCKET: &str = "/run/cognia-desktop/server.sock";
const MAX_STREAMS: usize = 32;
const IDLE: Duration = Duration::from_secs(60);

struct Slot(Arc<AtomicUsize>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn copy_bounded(mut reader: impl Read, mut writer: impl Write) -> io::Result<()> {
    let mut bytes = [0_u8; 16 * 1024];
    loop {
        let size = reader.read(&mut bytes)?;
        if size == 0 {
            return Ok(());
        }
        writer.write_all(&bytes[..size])?;
    }
}

fn bridge(client: TcpStream) -> io::Result<()> {
    let upstream = UnixStream::connect(SOCKET)?;
    client.set_read_timeout(Some(IDLE))?;
    client.set_write_timeout(Some(IDLE))?;
    upstream.set_read_timeout(Some(IDLE))?;
    upstream.set_write_timeout(Some(IDLE))?;
    let client_read = client.try_clone()?;
    let upstream_write = upstream.try_clone()?;
    let upstream_stop = upstream.try_clone()?;
    let client_stop = client.try_clone()?;
    thread::scope(|scope| {
        let incoming = scope.spawn(move || {
            let result = copy_bounded(client_read, upstream_write);
            // Preserve a client's write-half close: an HTTP response may still
            // be pending. An actual transport failure cancels both directions.
            if result.is_ok() {
                let _ = upstream_stop.shutdown(Shutdown::Write);
            } else {
                let _ = upstream_stop.shutdown(Shutdown::Both);
                let _ = client_stop.shutdown(Shutdown::Both);
            }
            result
        });
        let result = copy_bounded(&upstream, &client);
        let _ = upstream.shutdown(Shutdown::Both);
        let _ = client.shutdown(Shutdown::Both);
        incoming
            .join()
            .map_err(|_| io::Error::other("relay thread failed"))??;
        result
    })
}

pub(crate) fn run() -> io::Result<()> {
    if unsafe { libc::geteuid() } != 65534 || unsafe { libc::getegid() } != 65534 {
        return Err(io::Error::other("relay identity invalid"));
    }
    // The supervisor supplies the sole inheritable descriptor; command-line
    // arguments cannot select a listener or relay destination.
    let listener = unsafe { TcpListener::from_raw_fd(3) };
    if listener.local_addr()?.port() != 8000 {
        return Err(io::Error::other("relay listener invalid"));
    }
    if unsafe { libc::fcntl(listener.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let active = Arc::new(AtomicUsize::new(0));
    for client in listener.incoming() {
        let client = client?;
        if active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_STREAMS).then_some(count + 1)
            })
            .is_err()
        {
            drop(client);
            continue;
        }
        let slot = Slot(Arc::clone(&active));
        thread::Builder::new()
            .name("desktop-ingress".into())
            .spawn(move || {
                let _slot = slot;
                let _ = bridge(client);
            })?;
    }
    Err(io::Error::other("relay stopped"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_relay_preserves_http_and_websocket_bytes() {
        let bytes = b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n\x81\x03hey";
        let mut output = Vec::new();
        copy_bounded(&bytes[..], &mut output).unwrap();
        assert_eq!(output, bytes);
    }

    #[test]
    fn copy_failure_is_not_silently_truncated() {
        struct Refused;
        impl Write for Refused {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert!(copy_bounded(&b"data"[..], Refused).is_err());
    }

    #[test]
    fn stream_slot_is_returned_on_failure() {
        let active = Arc::new(AtomicUsize::new(MAX_STREAMS));
        {
            let _slot = Slot(Arc::clone(&active));
        }
        assert_eq!(active.load(Ordering::Acquire), MAX_STREAMS - 1);
    }
}
