use gst::{glib, prelude::*, subclass::prelude::*};
use gst_base::{
    prelude::*,
    subclass::{base_src::CreateSuccess, prelude::*},
};
use gstreamer as gst;
use gstreamer_base as gst_base;
use lvovd_media_ipc::{self as wire, client::Client};
use std::{
    net::Shutdown,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

glib::wrapper! {
    pub struct MediaSource(ObjectSubclass<imp::MediaSource>)
        @extends gst_base::BaseSrc, gst::Element, gst::Object,
        @implements gst::URIHandler;
}

mod imp {
    use super::*;
    struct OpenSource {
        id: uuid::Uuid,
        size: u64,
        client: Option<Client>,
    }
    #[derive(Default)]
    pub struct MediaSource {
        uri: Mutex<Option<String>>,
        open: Mutex<Option<OpenSource>>,
        interrupt: Mutex<Option<UnixStream>>,
        flushing: AtomicBool,
    }
    impl MediaSource {
        fn connect(&self, id: uuid::Uuid) -> std::io::Result<Client> {
            let path =
                PathBuf::from(std::env::var_os("LVOVD_MEDIA_SOCKET").ok_or_else(wire::invalid)?);
            let token = std::env::var("LVOVD_MEDIA_TOKEN")
                .ok()
                .and_then(|s| wire::decode_token(&s))
                .ok_or_else(wire::invalid)?;
            let client = Client::open(&path, &token, id)?;
            *self.interrupt.lock().unwrap() = Some(client.interrupter()?);
            if self.flushing.load(Ordering::Acquire) {
                self.disconnect();
                return Err(std::io::ErrorKind::Interrupted.into());
            }
            Ok(client)
        }
        fn disconnect(&self) {
            if let Some(stream) = self.interrupt.lock().unwrap().take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }
    #[glib::object_subclass]
    impl ObjectSubclass for MediaSource {
        const NAME: &'static str = "LvovdAuthorizedMediaSource";
        type Type = super::MediaSource;
        type ParentType = gst_base::BaseSrc;
        type Interfaces = (gst::URIHandler,);
    }
    impl ObjectImpl for MediaSource {
        fn constructed(&self) {
            self.parent_constructed();
            self.obj().set_format(gst::Format::Bytes);
            self.obj().set_blocksize(64 * 1024);
            self.obj().set_automatic_eos(true);
        }
    }
    impl GstObjectImpl for MediaSource {}
    impl ElementImpl for MediaSource {
        fn metadata() -> Option<&'static gst::subclass::ElementMetadata> {
            static METADATA: LazyLock<gst::subclass::ElementMetadata> = LazyLock::new(|| {
                gst::subclass::ElementMetadata::new(
                    "LVOVD authorized media",
                    "Source/File",
                    "Bounded reads from the LVOVD media owner",
                    "LVOVD contributors",
                )
            });
            Some(&METADATA)
        }
        fn pad_templates() -> &'static [gst::PadTemplate] {
            static PADS: LazyLock<Vec<gst::PadTemplate>> = LazyLock::new(|| {
                vec![
                    gst::PadTemplate::new(
                        "src",
                        gst::PadDirection::Src,
                        gst::PadPresence::Always,
                        &gst::Caps::new_any(),
                    )
                    .unwrap(),
                ]
            });
            &PADS
        }
    }
    impl URIHandlerImpl for MediaSource {
        const URI_TYPE: gst::URIType = gst::URIType::Src;
        fn protocols() -> &'static [&'static str] {
            &["lvovd-media"]
        }
        fn uri(&self) -> Option<String> {
            self.uri.lock().unwrap().clone()
        }
        fn set_uri(&self, uri: &str) -> Result<(), glib::Error> {
            let open = self.open.lock().unwrap();
            if open.is_some() || wire::asset_uri(uri).is_none() {
                return Err(glib::Error::new(
                    gst::URIError::BadUri,
                    "Invalid or active media identity",
                ));
            }
            *self.uri.lock().unwrap() = Some(uri.to_owned());
            Ok(())
        }
    }
    impl BaseSrcImpl for MediaSource {
        fn start(&self) -> Result<(), gst::ErrorMessage> {
            self.flushing.store(false, Ordering::Release);
            let mut open = self.open.lock().unwrap();
            let id = self
                .uri
                .lock()
                .unwrap()
                .as_deref()
                .and_then(wire::asset_uri)
                .ok_or_else(|| {
                    gst::error_msg!(
                        gst::ResourceError::OpenRead,
                        ["No authorized media identity"]
                    )
                })?;
            let client = self.connect(id).map_err(|_| {
                gst::error_msg!(
                    gst::ResourceError::OpenRead,
                    ["Could not open authorized media"]
                )
            })?;
            *open = Some(OpenSource {
                id,
                size: client.size,
                client: Some(client),
            });
            Ok(())
        }
        fn stop(&self) -> Result<(), gst::ErrorMessage> {
            self.flushing.store(true, Ordering::Release);
            self.disconnect();
            self.open.lock().unwrap().take();
            Ok(())
        }
        fn size(&self) -> Option<u64> {
            self.open.lock().unwrap().as_ref().map(|s| s.size)
        }
        fn is_seekable(&self) -> bool {
            true
        }
        fn do_seek(&self, segment: &mut gst::Segment) -> bool {
            segment.format() == gst::Format::Bytes
        }
        fn unlock(&self) -> Result<(), gst::ErrorMessage> {
            self.flushing.store(true, Ordering::Release);
            self.disconnect();
            Ok(())
        }
        fn unlock_stop(&self) -> Result<(), gst::ErrorMessage> {
            if let Some(open) = self.open.lock().unwrap().as_mut() {
                open.client = None;
            }
            self.flushing.store(false, Ordering::Release);
            Ok(())
        }
        fn create(
            &self,
            offset: u64,
            _buffer: Option<&mut gst::BufferRef>,
            length: u32,
        ) -> Result<CreateSuccess, gst::FlowError> {
            if self.flushing.load(Ordering::Acquire) {
                return Err(gst::FlowError::Flushing);
            }
            if length == 0 || length > wire::MAX_READ {
                return Err(gst::FlowError::Error);
            }
            let mut guard = self.open.lock().unwrap();
            let open = guard.as_mut().ok_or(gst::FlowError::Flushing)?;
            if offset >= open.size {
                return Err(gst::FlowError::Eos);
            }
            // A paused decoder may outlive the broker's idle deadline. Reconnect
            // once, re-authorizing the same identity and immutable size.
            for attempt in 0..2 {
                if self.flushing.load(Ordering::Acquire) {
                    return Err(gst::FlowError::Flushing);
                }
                if open.client.is_none() {
                    let client = self.connect(open.id).map_err(|_| gst::FlowError::Error)?;
                    if client.size != open.size {
                        return Err(gst::FlowError::Error);
                    }
                    open.client = Some(client);
                }
                match open.client.as_mut().unwrap().read(offset, length) {
                    Ok(bytes) => {
                        if self.flushing.load(Ordering::Acquire) {
                            return Err(gst::FlowError::Flushing);
                        }
                        if bytes.is_empty() {
                            return Err(gst::FlowError::Eos);
                        }
                        let end = offset + bytes.len() as u64;
                        let mut buffer = gst::Buffer::from_mut_slice(bytes);
                        let writable = buffer.get_mut().unwrap();
                        writable.set_offset(offset);
                        writable.set_offset_end(end);
                        return Ok(CreateSuccess::NewBuffer(buffer));
                    }
                    Err(_) => {
                        self.disconnect();
                        open.client = None;
                        if attempt == 1 {
                            return Err(gst::FlowError::Error);
                        }
                    }
                }
            }
            Err(gst::FlowError::Error)
        }
    }
}

fn plugin_init(plugin: &gst::Plugin) -> Result<(), glib::BoolError> {
    gst::Element::register(
        Some(plugin),
        "lvovdmediasrc",
        gst::Rank::PRIMARY,
        MediaSource::static_type(),
    )
}
gst::plugin_define!(
    lvovd,
    env!("CARGO_PKG_DESCRIPTION"),
    plugin_init,
    env!("CARGO_PKG_VERSION"),
    "Apache-2.0",
    "lvovd-gstreamer",
    "LVOVD",
    "https://github.com/landonrivers/LVOVD"
);
