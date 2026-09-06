#!/usr/bin/env bash
#
# Regenerates the PWA icons in public/ from public/favicon.svg.
#
# The PNGs are committed rather than rasterised during the build: the brand
# mark changes about once per project, and a committed asset keeps librsvg out
# of the Pages workflow. What that costs is reproducibility, which is what this
# script buys back — the exact commands, in the repo, next to their output.
#
# Requires librsvg: `brew install librsvg`.
set -euo pipefail

cd "$(dirname "$0")/.."
src=public/favicon.svg

# The "any" icons are just the favicon scaled up: its hairline frame is exactly
# the rounded tile a launcher draws around a non-maskable icon.
rsvg-convert -w 192 -h 192 "$src" -o public/icon-192.png
rsvg-convert -w 512 -h 512 "$src" -o public/icon-512.png

# The maskable icon is cropped by the launcher to a circle or a squircle, so the
# paper colour has to bleed to all four edges and the artwork has to stay inside
# the middle 80 % (410 of 512 px). The frame <rect> is therefore dropped — a
# rounded square clipped by a round mask reads as a rendering bug — and the leaf
# is *derived* from the favicon's <path> elements rather than redrawn, so the
# brand mark keeps exactly one source file.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
  echo '  <rect width="512" height="512" fill="#FAF8F3"/>'
  # 410 / 32 = 12.8125; centred at (512 - 410) / 2 = 51.
  echo '  <g transform="translate(51 51) scale(12.8125)">'
  grep '<path' "$src"
  echo '  </g>'
  echo '</svg>'
} > "$work/maskable.svg"
rsvg-convert -w 512 -h 512 "$work/maskable.svg" -o public/icon-512-maskable.png

echo "wrote public/icon-192.png public/icon-512.png public/icon-512-maskable.png"
