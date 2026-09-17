#!/usr/bin/env bash

set -euo pipefail

platform="${1:-}"
asset_url="${2:-}"
output_path="${3:-}"

if [[ -z "$platform" || -z "$asset_url" || -z "$output_path" ]]; then
  echo "::error::Usage: $0 <platform> <asset-url> <output-path>"
  exit 2
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "::error::GitHub token is required to download the $platform release asset"
  exit 1
fi

mkdir -p "$(dirname "$output_path")"
rm -f "$output_path"

# curl drops custom Authorization headers when a redirect changes hosts. This
# authenticates the GitHub request without sending the token to the signed
# release-asset host. Do not use curl's trusted-redirect option here.
if ! curl \
  --fail-with-body \
  --silent \
  --show-error \
  --location \
  --proto '=https' \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header "Accept: application/octet-stream" \
  "$asset_url" \
  --output "$output_path"; then
  rm -f "$output_path"
  echo "::error::Could not fetch the $platform private release asset"
  exit 1
fi

if [[ ! -s "$output_path" ]]; then
  rm -f "$output_path"
  echo "::error::The $platform private release asset download was empty"
  exit 1
fi