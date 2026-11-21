//! Optional preview artwork. Provider-supplied URLs never reach the webview.
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder};
use reqwest::{Client, Url, header, redirect};
use std::{
    io::Cursor,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::sync::Semaphore;
use url::Host;

const MAX_INPUT: usize = 2 * 1024 * 1024;
const MAX_PIXELS: u64 = 4_194_304;
const TIMEOUT: Duration = Duration::from_secs(3);
static DECODERS: Semaphore = Semaphore::const_new(1);

fn allowed_url(url: &Url, source: &Url) -> bool {
    url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https" || (url.scheme() == "http" && url.origin() == source.origin()))
        && (url.port().is_none() || url.origin() == source.origin())
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            a != 0
                && a < 224
                && !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_documentation()
                && !(a == 100 && (64..128).contains(&b))
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 192 && ((b == 0 && c == 0) || (b == 88 && c == 99)))
        }
        IpAddr::V6(ip) => {
            let [first, second, ..] = ip.segments();
            (0x2000..0x4000).contains(&first)
                && first != 0x2002
                && !(first == 0x2001 && (second < 0x0200 || second == 0x0db8))
                && !(first == 0x3fff && second < 0x1000)
        }
    }
}

async fn addresses(url: &Url) -> Option<Vec<SocketAddr>> {
    let port = url.port_or_known_default()?;
    let addrs = match url.host()? {
        Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Domain(host) => tokio::net::lookup_host((host, port))
            .await
            .ok()?
            .take(17)
            .collect(),
    };
    (!addrs.is_empty() && addrs.len() <= 16 && addrs.iter().all(|addr| public_address(addr.ip())))
        .then_some(addrs)
}

async fn read(mut url: Url, source: &Url) -> Option<(Vec<u8>, ImageFormat)> {
    for _ in 0..=3 {
        if !allowed_url(&url, source) {
            return None;
        }
        let addrs = addresses(&url).await?;
        // Connect to the vetted DNS answer. Check each redirect afresh and
        // keep cookies, credentials and ambient proxy settings out of the request.
        let client = Client::builder()
            .no_proxy()
            .redirect(redirect::Policy::none())
            .resolve_to_addrs(url.host_str()?, &addrs)
            .build()
            .ok()?;
        let mut response = client.get(url.clone()).send().await.ok()?;
        if response.status().is_redirection() {
            url = url
                .join(response.headers().get(header::LOCATION)?.to_str().ok()?)
                .ok()?;
            continue;
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_INPUT as u64)
        {
            return None;
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)?
            .to_str()
            .ok()?
            .split(';')
            .next()?
            .trim()
            .to_ascii_lowercase();
        let format = match content_type.as_str() {
            "image/jpeg" => ImageFormat::Jpeg,
            "image/png" => ImageFormat::Png,
            "image/webp" => ImageFormat::WebP,
            _ => return None,
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if chunk.len() > MAX_INPUT - bytes.len() {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        return Some((bytes, format));
    }
    None
}

fn thumbnail(bytes: &[u8], format: ImageFormat) -> Option<String> {
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) || image::guess_format(bytes).ok()? != format
    {
        return None;
    }
    let reader = || ImageReader::with_format(Cursor::new(bytes), format);
    let (width, height) = reader().into_dimensions().ok()?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(32 * 1024 * 1024);
    let mut decoder = reader();
    decoder.limits(limits);
    let raster = decoder.decode().ok()?.thumbnail(320, 180).into_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 75)
        .encode_image(&raster)
        .ok()?;
    (jpeg.len() <= 64 * 1024).then(|| format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg)))
}

pub(super) async fn fetch(candidate: &str, source_url: &str) -> Option<String> {
    if candidate.len() > 8192 {
        return None;
    }
    let url = Url::parse(candidate).ok()?;
    let source = Url::parse(source_url).ok()?;
    tokio::time::timeout(TIMEOUT, async {
        let (bytes, format) = read(url, &source).await?;
        let slot = DECODERS.try_acquire().ok()?;
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            thumbnail(&bytes, format)
        })
        .await
        .ok()?
    })
    .await
    .ok()?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artwork_cannot_target_private_hosts_or_forward_credentials() {
        for host in [
            "0.0.0.0",
            "127.0.0.1",
            "10.1.1.1",
            "100.64.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2002::1",
        ] {
            assert!(!public_address(host.parse().unwrap()), "{host}");
        }
        assert!(public_address("1.1.1.1".parse().unwrap()));
        assert!(public_address("2606:4700:4700::1111".parse().unwrap()));
        let source = Url::parse("https://example.org/media").unwrap();
        for url in [
            "file:///tmp/cover.jpg",
            "https://user@example.org/cover",
            "http://example.org/cover",
            "https://example.org:8443/cover",
        ] {
            assert!(!allowed_url(&Url::parse(url).unwrap(), &source));
        }
    }

    #[test]
    fn reencodes_only_valid_rasters_and_ignores_mismatched_content() {
        let input = image::RgbImage::new(4, 3);
        let mut bytes = Vec::new();
        JpegEncoder::new(&mut bytes).encode_image(&input).unwrap();
        assert!(
            thumbnail(&bytes, ImageFormat::Jpeg)
                .unwrap()
                .starts_with("data:image/jpeg;base64,")
        );
        assert!(thumbnail(&bytes, ImageFormat::Png).is_none());
        assert!(thumbnail(b"<svg></svg>", ImageFormat::Jpeg).is_none());
        assert!(thumbnail(&bytes[..5], ImageFormat::Jpeg).is_none());
    }
}
