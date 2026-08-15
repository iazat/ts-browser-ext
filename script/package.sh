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
  icon.png
  online.png
  offline.png
  need-install.png
)

rm -rf "$out"
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

  (cd "$stage" && zip -qr "../ts-browser-ext-$name-v$version.zip" .)
  rm -rf "$stage"
  echo "$out/ts-browser-ext-$name-v$version.zip"
}

package chrome .
package firefox firefox
