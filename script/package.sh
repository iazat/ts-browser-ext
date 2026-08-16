#!/usr/bin/env bash
# Packages the two extensions for distribution.
#
# The repository root doubles as the Chrome extension directory, so it also
# holds the Go sources, tests, node_modules and CI config. None of that
# belongs in something people load into their browser, so the contents are
# listed explicitly rather than filtered — a missing file fails the build
# here instead of producing a half-working extension.
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:-$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json | head -1)}"
out="dist"

# Shared by both builds. The Chrome copy lives at the root, the Firefox one
# under firefox/, and each has its own manifest, background script and popup.
files=(
  manifest.json
  background.js
  popup.html
  popup.js
)

# Clear only what this script produces. dist/ is shared — script/screenshots.mjs
# writes the store screenshots there too, and wiping the directory wholesale
# deleted them.
rm -rf "$out"/chrome "$out"/firefox
rm -f "$out"/ts-browser-ext-*.zip
mkdir -p "$out"

package() {
  local name="$1" src="$2" stage
  stage="$out/$name"
  mkdir -p "$stage"

  for f in "${files[@]}"; do
    cp "$src/$f" "$stage/"
  done
  cp -r "$src/fonts" "$stage/"
  cp -r "$src/icons" "$stage/"
  cp LICENSE "$stage/"

  # Zip records file timestamps, so an unmodified rebuild would otherwise
  # produce a different checksum every time and a published asset could not be
  # checked against a local build. Flatten the timestamps and drop the extra
  # attribute blocks, and the archive becomes a function of its contents.
  find "$stage" -exec touch -t 198001010000 {} +
  (cd "$stage" && zip -qrX "../ts-browser-ext-$name-v$version.zip" .)
  rm -rf "$stage"
  echo "$out/ts-browser-ext-$name-v$version.zip"
}

package chrome .
package firefox firefox
