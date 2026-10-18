#!/usr/bin/env bash
# Development CI prerequisite, not a redistributed application tool package.
set -euo pipefail
version=6.1.6
sha256=d4fcb164028dd3beee5d92c0ac72e46aac6973c75ea12dc14de07bf8f407370a
prefix="$GITHUB_WORKSPACE/outputs/ci-ffmpeg"
if [[ ! -x "$prefix/bin/ffmpeg" || ! -x "$prefix/bin/ffprobe" ]]; then
  build_dir=$(mktemp -d "$RUNNER_TEMP/lvovd-ffmpeg.XXXXXX")
  archive="$build_dir/ffmpeg.tar.xz"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 120 --max-filesize 20000000 \
    --output "$archive" "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz"
  printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --strict
  tar -xJf "$archive" --directory "$build_dir"
  cd "$build_dir/ffmpeg-$version"
  ./configure --prefix="$prefix" --disable-debug --disable-doc --disable-ffplay \
    --disable-autodetect --enable-gpl --enable-libx264 --enable-libopus --enable-libmp3lame
  make -j "$(nproc)"
  make install
fi
"$prefix/bin/ffmpeg" -version
"$prefix/bin/ffprobe" -version
printf '%s\n' "$prefix/bin" >> "$GITHUB_PATH"
