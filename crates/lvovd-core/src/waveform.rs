//! Combined-channel overview, with constant-size decode chunks and bounded bins.
use crate::{AppError, Result};

pub const MAX_PAIRS: usize = 200_000;
pub const MAX_WINDOW: usize = 4096;
pub struct Peaks {
    pub duration: f64,
    pub bin_seconds: f64,
    pairs: Vec<[f32; 2]>,
    channels: usize,
    expected_frames: u64,
    frames_per_bin: u64,
    frames: u64,
    bytes: u64,
    maximum_bytes: u64,
    tolerance: u64,
    tail: Vec<u8>,
}
fn invalid(message: &str) -> AppError {
    AppError::new("WAVEFORM_INVALID", message)
}
impl Peaks {
    pub fn new(duration: f64, rate: u64, channels: u64) -> Result<Self> {
        if !duration.is_finite()
            || duration <= 0.
            || rate == 0
            || rate > 768_000
            || !(1..=8).contains(&channels)
        {
            return Err(invalid("Waveform timing or channels are unsupported."));
        }
        let count = (duration * rate as f64).ceil();
        if !count.is_finite() || count > (u64::MAX / (channels * 4) - rate) as f64 {
            return Err(invalid("Waveform duration exceeds its byte bound."));
        }
        let expected_frames = count as u64;
        let frames_per_bin = rate
            .div_ceil(100)
            .max(expected_frames.div_ceil(MAX_PAIRS as u64));
        Ok(Self {
            duration,
            bin_seconds: frames_per_bin as f64 / rate as f64,
            pairs: vec![
                [f32::INFINITY, f32::NEG_INFINITY];
                expected_frames.div_ceil(frames_per_bin) as usize
            ],
            channels: channels as usize,
            expected_frames,
            frames_per_bin,
            frames: 0,
            bytes: 0,
            maximum_bytes: (expected_frames + rate) * channels * 4,
            tolerance: rate.div_ceil(500),
            tail: vec![],
        })
    }
    pub fn push(&mut self, chunk: &[u8]) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(chunk.len() as u64)
            .filter(|v| *v <= self.maximum_bytes)
            .ok_or_else(|| {
                invalid("Waveform decoder exceeded the inspected duration byte bound.")
            })?;
        // The supervisor supplies at most 8192 bytes. Do not accept an unbounded
        // caller chunk and accidentally retain the entire decoded source.
        if chunk.len() > 8192 {
            return Err(invalid("Waveform decode chunk exceeded its limit."));
        }
        self.tail.extend_from_slice(chunk);
        let stride = self.channels * 4;
        let complete = self.tail.len() / stride * stride;
        for frame in self.tail[..complete].chunks_exact(stride) {
            let bin = (self.frames / self.frames_per_bin) as usize;
            for sample in frame.as_chunks::<4>().0 {
                let value = f32::from_le_bytes(*sample);
                if !value.is_finite() {
                    return Err(invalid("Waveform decoder returned non-finite samples."));
                }
                if let Some(pair) = self.pairs.get_mut(bin) {
                    pair[0] = pair[0].min(value);
                    pair[1] = pair[1].max(value);
                }
            }
            self.frames += 1;
        }
        self.tail.drain(..complete);
        Ok(())
    }
    pub fn finish(&mut self) -> Result<()> {
        if !self.tail.is_empty()
            || self.frames < self.expected_frames.saturating_sub(self.tolerance)
        {
            return Err(invalid("Waveform decoder returned incomplete samples."));
        }
        for pair in &mut self.pairs {
            if pair[0].is_infinite() {
                *pair = [0., 0.];
            }
        }
        Ok(())
    }
    pub fn window(&self, start: f64, end: f64, points: usize) -> Result<Vec<[f64; 2]>> {
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.
            || end <= start
            || end > self.duration + 0.001
            || !(1..=MAX_WINDOW).contains(&points)
        {
            return Err(invalid("Choose a valid waveform window and 1–4096 points."));
        }
        let count = points.min(((end - start) / self.bin_seconds).ceil().max(1.) as usize);
        Ok((0..count)
            .map(|index| {
                let first = ((start + (end - start) * index as f64 / count as f64)
                    / self.bin_seconds)
                    .floor() as usize;
                let last = (((start + (end - start) * (index + 1) as f64 / count as f64)
                    / self.bin_seconds)
                    .ceil() as usize)
                    .min(self.pairs.len());
                let mut pair = [f32::INFINITY, f32::NEG_INFINITY];
                for p in self.pairs.get(first..last).unwrap_or(&[]) {
                    pair[0] = pair[0].min(p[0]);
                    pair[1] = pair[1].max(p[1]);
                }
                if pair[0].is_infinite() {
                    return [0., 0.];
                }
                pair.map(|n| (f64::from(n.clamp(-1., 1.)) * 1_000_000.).round() / 1_000_000.)
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_channels_bounds_and_windows() {
        let mut peaks = Peaks::new(0.02, 1000, 2).unwrap();
        let samples: Vec<_> = (0..20)
            .flat_map(|_| [-0.25f32, 0.75])
            .flat_map(f32::to_le_bytes)
            .collect();
        for chunk in samples.chunks(7) {
            peaks.push(chunk).unwrap();
        }
        peaks.finish().unwrap();
        assert_eq!(
            peaks.window(0., 0.02, 4096).unwrap(),
            vec![[-0.25, 0.75]; 2]
        );
        assert!(peaks.window(0., 0.03, 1).is_err());
        assert!(peaks.window(0., 0.02, 4097).is_err());
        let long = Peaks::new(86400., 48000, 8).unwrap();
        assert!(long.pairs.len() <= MAX_PAIRS && long.bin_seconds >= 0.01);
        let mut bad = Peaks::new(0.01, 1000, 1).unwrap();
        assert!(bad.push(&f32::NAN.to_le_bytes()).is_err());
        assert!(Peaks::new(f64::MAX, 48000, 2).is_err());
        let mut short = Peaks::new(1., 1000, 1).unwrap();
        short.push(&[0; 3]).unwrap();
        assert!(short.finish().is_err());
        let mut over = Peaks::new(0.001, 1000, 1).unwrap();
        assert!(over.push(&[0; 4096]).is_err());
    }
}
