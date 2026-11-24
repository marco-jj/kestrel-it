#!/bin/sh
set -eu

# The daemon creates the node identity in the shared metadata volume.
attempt=0
until node="$(/garage node id -q 2>/dev/null)" && [ -n "$node" ] &&
  /garage -h "$node" status >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Garage RPC is not ready. Check garage.toml and the garage service logs." >&2
    exit 1
  fi
  sleep 1
done

garage() {
  /garage -h "$node" "$@"
}

layout="$(garage layout show)"
if printf '%s\n' "$layout" | grep -q '^Current cluster layout version: 0$'; then
  garage layout assign -z local -c 1G "${node%%@*}"
  garage layout apply --version 1
fi

if ! garage bucket info "$S3_BUCKET" >/dev/null 2>&1; then
  garage bucket create "$S3_BUCKET"
fi
if ! garage key info "$S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  garage key import --yes -n kestrel-compose "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
fi
garage bucket allow --read --write "$S3_BUCKET" --key "$S3_ACCESS_KEY_ID"
