#![cfg(unix)]
use lvovd_core::{assets::Assets, playback::Broker};
use lvovd_media_ipc::{self as wire, client::Client};
use std::{
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

async fn fixture() -> (
    tempfile::TempDir,
    Arc<Assets>,
    lvovd_core::assets::Source,
    Vec<u8>,
) {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("synthetic.wav");
    let data = 96000u32;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend((36 + data).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(48000u32.to_le_bytes());
    bytes.extend(96000u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(data.to_le_bytes());
    bytes.resize(44 + data as usize, 0);
    std::fs::write(&input, &bytes).unwrap();
    let assets = Arc::new(Assets::new(root.path()).unwrap());
    let tool = PathBuf::from(std::env::var_os("LVOVD_DESKTOP_FFPROBE").expect("FFprobe required"));
    let source = assets.import(&input, &tool).await.unwrap();
    (root, assets, source, bytes)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn broker_keeps_reads_bounded_and_revokes_active_decoders() {
    let (root, assets, source, original) = fixture().await;
    let path = root.path().join("media.sock");
    let token = [42; 32];
    let broker = Broker::start(
        UnixListener::bind(&path).unwrap(),
        token,
        assets.clone(),
        Arc::new(|| {}),
    )
    .unwrap();
    let client_path = path.clone();
    let (mut client, bytes) = tokio::task::spawn_blocking(move || {
        let mut client = Client::open(&client_path, &token, source.asset_id).unwrap();
        let bytes = client.read(0, 44).unwrap();
        assert!(client.read(0, wire::MAX_READ + 1).is_err());
        assert_eq!(client.read(client.size, 1).unwrap(), Vec::<u8>::new());
        (client, bytes)
    })
    .await
    .unwrap();
    assert_eq!(bytes, original[..44]);
    // The idle broker may observe cancellation and drop its lease before
    // remove checks the count. Hold a reader explicitly to make pending
    // cleanup deterministic while still testing the live decoder's revocation.
    let held_reader = assets.lease(source.asset_id).unwrap();
    assert!(!assets.remove(source.asset_id).unwrap().cleanup_complete);
    assert!(
        tokio::task::spawn_blocking(move || client.read(0, 44))
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(assets.pending_cleanup(), [source.asset_id]);
    assert!(held_reader.read(0, 44).is_err());
    drop(held_reader);
    assets.retry_pending_cleanup();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !assets.pending_cleanup().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(root.path().join("synthetic.wav")).unwrap(),
        original
    );
    let missing =
        tokio::task::spawn_blocking(move || Client::open(&path, &token, source.asset_id).is_err())
            .await
            .unwrap();
    assert!(missing);
    broker.shutdown().await;
    assets.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hostile_connections_time_out_and_shutdown_releases_every_lease() {
    let (root, assets, source, _) = fixture().await;
    let path = root.path().join("media.sock");
    let token = [51; 32];
    let broker = Broker::start(
        UnixListener::bind(&path).unwrap(),
        token,
        assets.clone(),
        Arc::new(|| {}),
    )
    .unwrap();
    let address = path.clone();
    tokio::task::spawn_blocking(move || {
        assert!(Client::open(&address, &[0; 32], source.asset_id).is_err());
        assert!(Client::open(&address, &token, Uuid::new_v4()).is_err());
        let mut stream = UnixStream::connect(&address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .write_all(&wire::hello(&token, source.asset_id))
            .unwrap();
        let mut header = [0; 9];
        stream.read_exact(&mut header).unwrap();
        stream
            .write_all(&wire::request(0, wire::MAX_READ + 1))
            .unwrap();
        assert!(stream.read_exact(&mut [0; 1]).is_err());
        // A partial greeting must not occupy an admission slot indefinitely.
        let mut slow = UnixStream::connect(&address).unwrap();
        slow.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        slow.write_all(b"L").unwrap();
        assert_eq!(slow.read(&mut [0; 1]).unwrap(), 0);
    })
    .await
    .unwrap();
    let address = path.clone();
    let clients = tokio::task::spawn_blocking(move || {
        let mut clients = Vec::new();
        for _ in 0..wire::MAX_CONNECTIONS {
            clients.push(Client::open(&address, &token, source.asset_id).unwrap());
        }
        assert!(Client::open(&address, &token, source.asset_id).is_err());
        clients
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), broker.shutdown())
        .await
        .unwrap();
    assert!(assets.remove(source.asset_id).unwrap().cleanup_complete);
    drop(clients);
    assets.shutdown().await.unwrap();
}

#[test]
fn decoder_rejects_oversized_responses_before_allocation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("malformed.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut hello = [0; wire::HELLO_BYTES];
        stream.read_exact(&mut hello).unwrap();
        let mut header = [0; 9];
        header[1..].copy_from_slice(&100u64.to_le_bytes());
        stream.write_all(&header).unwrap();
        let mut request = [0; 12];
        stream.read_exact(&mut request).unwrap();
        let mut response = [0; 5];
        response[1..].copy_from_slice(&u32::MAX.to_le_bytes());
        stream.write_all(&response).unwrap();
    });
    let mut client = Client::open(&path, &[0; 32], Uuid::new_v4()).unwrap();
    assert_eq!(
        client.read(0, 10).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
    worker.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crashed_decoder_releases_lease_and_failed_cleanup_remains_retryable() {
    use std::os::unix::fs::PermissionsExt;
    let (root, assets, source, original) = fixture().await;
    let path = root.path().join("media.sock");
    let token = [12; 32];
    let broker = Broker::start(
        UnixListener::bind(&path).unwrap(),
        token,
        assets.clone(),
        Arc::new(|| {}),
    )
    .unwrap();
    let client =
        tokio::task::spawn_blocking(move || Client::open(&path, &token, source.asset_id).unwrap())
            .await
            .unwrap();
    let lease = assets.lease(source.asset_id).unwrap();
    drop(client); // EOF is how a crashed decoder releases its connection.
    tokio::time::timeout(Duration::from_secs(2), async {
        while Arc::strong_count(&lease) > 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(lease);
    let session = std::fs::read_dir(root.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.is_dir())
        .unwrap();
    std::fs::set_permissions(&session, std::fs::Permissions::from_mode(0o500)).unwrap();
    let removal = assets.remove(source.asset_id).unwrap();
    std::fs::set_permissions(&session, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        !removal.cleanup_complete,
        "failed deletion must remain owned"
    );
    assert_eq!(assets.pending_cleanup(), [source.asset_id]);
    assert!(assets.lease(source.asset_id).is_err());
    assert!(assets.remove(source.asset_id).unwrap().cleanup_complete);
    assert_eq!(
        std::fs::read(root.path().join("synthetic.wav")).unwrap(),
        original
    );
    broker.shutdown().await;
    assets.shutdown().await.unwrap();
}

#[test]
fn stalled_decoder_response_has_a_transaction_deadline() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("stalled.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut hello = [0; wire::HELLO_BYTES];
        stream.read_exact(&mut hello).unwrap();
        // A peer that sends occasional bytes must not reset the whole deadline.
        for _ in 0..9 {
            if stream.write_all(&[0]).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(600));
        }
    });
    let start = std::time::Instant::now();
    assert!(Client::open(&path, &[0; 32], Uuid::new_v4()).is_err());
    assert!(start.elapsed() < Duration::from_secs(4));
    worker.join().unwrap();
}
