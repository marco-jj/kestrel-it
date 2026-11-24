#!/usr/bin/env bash
set -euo pipefail

api_image=${1:?API image required}
web_image=${2:?Web image required}
id="kestrel-smoke-$$-$RANDOM"
cleanup() {
  result=$?
  if (( result != 0 )); then
    for component in postgres api web; do
      docker logs "$id-$component" >&2 || true
    done
  fi
  docker rm -f "$id-web" "$id-api" "$id-postgres" >/dev/null 2>&1 || true
  docker network rm "$id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$id" >/dev/null
docker run -d --name "$id-postgres" --network "$id" --network-alias postgres \
  -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=kestrel postgres:16-alpine >/dev/null
for attempt in {1..45}; do
  if docker exec "$id-postgres" pg_isready -h 127.0.0.1 -U postgres -d kestrel; then break; fi
  sleep 2
done
docker exec "$id-postgres" pg_isready -h 127.0.0.1 -U postgres -d kestrel

docker run -d --name "$id-api" --network "$id" --network-alias api \
  -e DATABASE_URL=postgresql://postgres:smoke@postgres:5432/kestrel \
  -e JWT_SECRET="$(openssl rand -hex 32)" -e APP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -p 127.0.0.1::3000 "$api_image" >/dev/null
api="http://$(docker port "$id-api" 3000/tcp)"
curl --retry 45 --retry-delay 2 --retry-all-errors --max-time 10 -fsS "$api/ready"

docker run -d --name "$id-web" --network "$id" -p 127.0.0.1::80 \
  -e KESTREL_API_ORIGIN=http://api:3000 "$web_image" >/dev/null
web="http://$(docker port "$id-web" 80/tcp)"
curl --retry 15 --retry-delay 1 --retry-all-errors --max-time 10 -fsS "$web/login" | grep '<kestrel-root'
curl --max-time 10 -fsS "$web/api/v1/setup/status" | jq -e '.setupCompleted == false and .checks.database == true and .checks.storageWritable == true'
