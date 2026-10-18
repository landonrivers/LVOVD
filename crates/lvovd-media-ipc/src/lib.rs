//! Fixed-size, versioned messages for the private Linux decoder transport.
//! No message contains a filesystem path, executable, or arbitrary operation.
use std::{io, time::Duration};
use uuid::Uuid;

pub const MAGIC: [u8; 4] = *b"LVM1";
pub const HELLO_BYTES: usize = 52;
pub const MAX_READ: u32 = 1024 * 1024;
pub const MAX_CONNECTIONS: usize = 8;
pub const IO_TIMEOUT: Duration = Duration::from_secs(3);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

pub fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid media transport response",
    )
}

pub fn asset_uri(uri: &str) -> Option<Uuid> {
    let value = uri.strip_prefix("lvovd-media://localhost/")?;
    let id = Uuid::parse_str(value).ok()?;
    (value == id.to_string() && id.get_version_num() == 4).then_some(id)
}

pub fn decode_token(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut token = [0; 32];
    for (i, byte) in token.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(token)
}

pub fn hello(token: &[u8; 32], id: Uuid) -> [u8; HELLO_BYTES] {
    let mut bytes = [0; HELLO_BYTES];
    bytes[..4].copy_from_slice(&MAGIC);
    bytes[4..36].copy_from_slice(token);
    bytes[36..].copy_from_slice(id.as_bytes());
    bytes
}

pub fn authorize(bytes: &[u8; HELLO_BYTES], token: &[u8; 32]) -> Option<Uuid> {
    // Compare every token byte, rather than disclosing matching prefixes.
    let difference = bytes[4..36]
        .iter()
        .zip(token)
        .fold(0, |a, (b, c)| a | (b ^ c));
    if bytes[..4] != MAGIC || difference != 0 {
        return None;
    }
    let id = Uuid::from_slice(&bytes[36..]).ok()?;
    (id.get_version_num() == 4).then_some(id)
}

pub fn request(offset: u64, count: u32) -> [u8; 12] {
    let mut bytes = [0; 12];
    bytes[..8].copy_from_slice(&offset.to_le_bytes());
    bytes[8..].copy_from_slice(&count.to_le_bytes());
    bytes
}

pub fn read_range(bytes: [u8; 12], size: u64) -> Option<(u64, usize)> {
    let offset = u64::from_le_bytes(bytes[..8].try_into().ok()?);
    let count = u32::from_le_bytes(bytes[8..].try_into().ok()?);
    if count == 0 || count > MAX_READ || offset > size {
        return None;
    }
    Some((offset, (count as u64).min(size - offset) as usize))
}

#[cfg(unix)]
pub mod client {
    use super::*;
    use socket2::{Domain, SockAddr, Socket, Type};
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
        path::Path,
    };

    pub struct Client {
        pub size: u64,
        stream: UnixStream,
    }
    impl Client {
        pub fn open(path: &Path, token: &[u8; 32], id: Uuid) -> io::Result<Self> {
            if !path.is_absolute() {
                return Err(invalid());
            }
            let socket = Socket::new(Domain::UNIX, Type::STREAM, None)?;
            socket.connect_timeout(&SockAddr::unix(path)?, IO_TIMEOUT)?;
            let mut stream: UnixStream = socket.into();
            stream.set_read_timeout(Some(IO_TIMEOUT))?;
            stream.set_write_timeout(Some(IO_TIMEOUT))?;
            stream.write_all(&hello(token, id))?;
            let mut response = [0; 9];
            stream.read_exact(&mut response)?;
            let size = u64::from_le_bytes(response[1..].try_into().unwrap());
            if response[0] != 0 || size == 0 || size > 100 * 1024 * 1024 * 1024 {
                return Err(invalid());
            }
            Ok(Self { size, stream })
        }
        pub fn interrupter(&self) -> io::Result<UnixStream> {
            self.stream.try_clone()
        }
        pub fn read(&mut self, offset: u64, count: u32) -> io::Result<Vec<u8>> {
            let (_, expected) =
                read_range(request(offset, count), self.size).ok_or_else(invalid)?;
            self.stream.write_all(&request(offset, count))?;
            let mut header = [0; 5];
            self.stream.read_exact(&mut header)?;
            let length = u32::from_le_bytes(header[1..].try_into().unwrap()) as usize;
            // Validate the length before allocating, including exact EOF semantics.
            if header[0] != 0 || length != expected {
                return Err(invalid());
            }
            let mut bytes = vec![0; length];
            self.stream.read_exact(&mut bytes)?;
            Ok(bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_authentication_and_ranges_fail_closed() {
        let id = Uuid::new_v4();
        assert_eq!(
            asset_uri(&format!("lvovd-media://localhost/{id}")),
            Some(id)
        );
        for uri in [
            format!("lvovd-media://evil/{id}"),
            format!("lvovd-media://localhost/{id}?path=/etc/passwd"),
            "lvovd-media://localhost/../../etc/passwd".into(),
            format!("lvovd-media://localhost/{}", id.to_string().to_uppercase()),
        ] {
            assert_eq!(asset_uri(&uri), None);
        }
        let token = [23; 32];
        assert_eq!(authorize(&hello(&token, id), &token), Some(id));
        let mut bytes = hello(&token, id);
        bytes[4] ^= 1;
        assert_eq!(authorize(&bytes, &token), None);
        bytes = hello(&token, id);
        bytes[3] = b'2';
        assert_eq!(authorize(&bytes, &token), None);
        assert_eq!(read_range(request(9, 4), 10), Some((9, 1)));
        assert_eq!(read_range(request(10, 4), 10), Some((10, 0)));
        for (offset, count) in [(0, 0), (0, MAX_READ + 1), (u64::MAX, 1)] {
            assert_eq!(read_range(request(offset, count), 10), None);
        }
        assert_eq!(decode_token(&"0a".repeat(32)), Some([10; 32]));
        assert_eq!(decode_token(&"x".repeat(64)), None);
    }
}
