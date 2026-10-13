#!/bin/bash

# Render the icon PNGs from the vector source.
#
# Two outputs, one source: the copy you can look at and hand out
# (assets/icon-128.png) and the copy the add-on package loads
# (extension/icon.png). Run this after editing icon.svg so they cannot drift.

set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

command -v rsvg-convert >/dev/null || { echo "render.sh: rsvg-convert is required" >&2; exit 1; }

rsvg-convert -w 128 -h 128 icon.svg -o icon-128.png
rsvg-convert -w 128 -h 128 icon.svg -o ../extension/icon.png

echo "Rendered assets/icon-128.png and extension/icon.png (128x128)"
