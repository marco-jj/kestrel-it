# Kestrel-IT

A modern, cloud-native IT Asset Management (ITAM) platform built with **Node.js / TypeScript**, **Angular**, and **PostgreSQL**, packaged for Kubernetes with a **single Helm chart**.

> **Project Lineage:** Kestrel-IT is a clean-room TypeScript rewrite and next-generation fork/reimplementation of [**Snipe-IT**](https://github.com/grokability/snipe-it) by Grokability, aiming for full functional parity with Snipe-IT while modernizing the UI, architecture, authentication, and storage layers.

---

## Why Kestrel-IT?

Snipe-IT has proven, battle-tested ITAM workflows, but its PHP/Laravel monolith and Bootstrap 3 / AdminLTE 2 frontend are showing their age. Kestrel-IT preserves Snipe-IT's feature set while introducing:

- **Modern Decoupled Stack:** TypeScript end-to-end with a **Node.js** backend and an **Angular** SPA frontend.
- **PostgreSQL-First:** Powered by **Drizzle ORM**, using `JSONB` for dynamic custom fields instead of runtime `ALTER TABLE` schema mutations.
- **Authentication:** Local login with TOTP, OpenID Connect (OIDC), OAuth Authorization Code with PKCE, and personal access tokens. A Better Auth session bridge is in development. See the [feature map](docs/08-upstream-feature-map.md) for upstream compatibility.
- **Pluggable Storage:** Unified storage abstraction supporting **Local**, **Native S3** (AWS S3, MinIO, Cloudflare R2, etc.), and **Nextcloud** (WebDAV).
- **Kubernetes-Ready:** Deployed via a **single Helm chart** covering both backend and frontend (plus optional PostgreSQL dependency).

---

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Backend** | Node.js, TypeScript (NestJS / Fastify) |
| **ORM / Database** | Drizzle ORM, PostgreSQL |
| **Frontend** | Angular (standalone components, Signals) |
| **Auth** | Local/TOTP, OIDC, OAuth Authorization Code with PKCE, PAT, Better Auth session bridge |
| **Storage** | Local FS, Native S3 (`@aws-sdk/client-s3`), Nextcloud (WebDAV) |
| **Deployment** | Docker, single Helm Chart (Kubernetes) |

---

## Monorepo Structure

```text
kestrel-it/
├── apps/
│   ├── api/            # Node.js / TypeScript REST API & background workers
│   └── web/            # Angular frontend application
├── packages/
│   └── shared/         # Shared TypeScript types, validation schemas, & RBAC enums
└── deploy/
    └── helm/           # Single Helm chart for API, Web, & optional PostgreSQL
```

---

## Target Feature Parity (Snipe-IT)

- **Core Inventory:** Assets, Asset Models, Categories, Manufacturers, Suppliers, Locations, Departments, Status Labels
- **Asset Lifecycle:** Checkout / Checkin (to Users, Locations, or Assets), EULA & Acceptance workflows, Audits, Maintenance, Depreciation schedules
- **Secondary Inventory:** Licenses (and seat management), Accessories, Consumables, Components, Predefined Kits
- **Custom Fields & Fieldsets:** Dynamic per-model attributes stored in PostgreSQL `JSONB`, searchable and exportable
- **Access Control:** Granular RBAC policies & Full Multiple Company Support (FMCS)
- **Operations:** Bulk CSV/Excel imports & exports, QR/Barcode label generation, Scheduled jobs, Multi-channel notifications (Email, Slack, Teams, Webhook)
- **Migration Tooling:** One-time importer from existing Snipe-IT (MySQL/MariaDB) databases to Kestrel-IT (PostgreSQL)

---

The [Snipe-IT feature map](docs/08-upstream-feature-map.md) links observed upstream behavior to Kestrel-IT equivalents, parity evidence, and open decisions.

## Run locally with Docker Compose

Create a `garage.toml` file in the repository root with this single-node configuration. The example RPC secret and the default Compose credentials are for local development. Keep your local configuration out of version control.

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"
replication_factor = 1
rpc_bind_addr = "0.0.0.0:3901"
rpc_public_addr = "garage:3901"
rpc_secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

[s3_api]
s3_region = "garage"
api_bind_addr = "0.0.0.0:3900"
```

```sh
chmod 600 garage.toml
docker compose up -d
```

Compose builds the API and web targets from `deploy/images/Dockerfile`. It starts PostgreSQL, initializes the Garage layout, bucket, and access key, then starts the API and web app. Open [http://localhost:4200/setup](http://localhost:4200/setup) and complete the setup wizard. If startup is still in progress, check `docker compose ps -a`. A successful `garage-init` run exits with code 0.

The browser uses `http://localhost:4200/api/v1`. Nginx forwards those requests to the API container, which also listens directly at `http://localhost:3000/api/v1`. Garage's S3 endpoint is `http://garage:3900` inside Compose and `http://localhost:3900` from the host. Garage and PostgreSQL data persist in named volumes. You can use an optional root `.env` for API settings. If you have an older MinIO configuration, replace the S3 credentials and region with the Garage values in [.env.example](.env.example). Keep `S3_REGION` aligned with `s3_region` in `garage.toml`.

### Use Angular's local dev server

To develop the frontend with live reload, start just its backend services and run Angular on the host.

```sh
docker compose stop web
docker compose up -d api
pnpm install
pnpm build:shared
pnpm --filter @kestrel-it/web exec ng serve
```

The Angular serve target reads [proxy.conf.json](apps/web/proxy.conf.json) and forwards `/api/v1/**` to `http://127.0.0.1:3000` so the browser retains a single origin. The backend serves `/api/v1` directly. The Compose web container provides its own proxy through Nginx.

## Install the beta

Kestrel-IT is distributed as a single OCI Helm chart. For the install command, cluster values, and use as a Helm dependency, see the [chart guide](deploy/helm/kestrel-it/README.md). See the [changelog](CHANGELOG.md) for the beta scope and [release process](RELEASE.md) for publication.

## Database startup and Helm configuration

The API applies the checked-in Drizzle migrations before first-run setup. Replicas serialize migration and headless bootstrap through a PostgreSQL advisory lock. The Helm chart probes `/health` for liveness and `/ready` for database and schema readiness.

When managing migrations separately, set `DB_AUTO_MIGRATE=false` (`config.dbAutoMigrate=false` in Helm) and run `pnpm --filter @kestrel-it/api db:migrate` with `DATABASE_URL` set before starting the API. Readiness requires a journal entry with the matching timestamp and hash for each migration shipped with the release. With separate migration and API roles, give the API role `USAGE` on the `drizzle` schema and `SELECT` on `drizzle.__drizzle_migrations`.

For a database created by running the initial SQL manually, confirm that the SQL was applied successfully, then record it in the Drizzle journal once before running `db:migrate`.

```sql
BEGIN;
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '70d4e8e953d9b794787c0ee20d04ca7140c88d3c8d8b668b3e107741fbb7f713', 1795227931162
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1795227931162);
COMMIT;
```

If you also applied `0001_auth_consumption_and_oidc.sql` manually, record it the same way with timestamp `1795386212405` and hash `e435e8eb60ae8cd2a374b7202ed07d2afe57d41cafde89cf3b1b2193be6413d9`. If the unique OIDC index reports duplicate active identities, reconcile those identities before retrying the migration. [Migration](apps/api/drizzle/0001_auth_consumption_and_oidc.sql)

Provide production JWT and encryption keys through `config.secrets` or `config.existingSecret`, and supply `postgresql.auth.password` when using bundled PostgreSQL. Set `config.appUrl` to the public HTTPS origin used by the browser. The default local volume supports a single API replica. Use S3, Nextcloud, or a ReadWriteMany volume to scale past one.

Enabling Better Auth requires a dedicated `BETTER_AUTH_SECRET` of at least 32 characters. In Helm, use `config.betterAuth.secret` or supply the key in `config.existingSecret`.

## OpenAPI & Verification

- **Build & Typecheck:** `pnpm build` and `pnpm typecheck`
- **Tests:** `pnpm test` (set `INVENTORY_TEST_DATABASE_URL` for PostgreSQL 16 integration suites in `@kestrel-it/api`)
- **OpenAPI Contract (`docs/openapi.json`):** generated from NestJS Swagger decorators and Zod schemas via Zod's JSON Schema exporter:
  - `pnpm --filter @kestrel-it/api openapi:export` — regenerate `docs/openapi.json`
  - `pnpm --filter @kestrel-it/api openapi:check` — verify `docs/openapi.json` matches the current API contract

## Roadmap

- [x] **Phase 1 — Foundation:** Monorepo setup, Drizzle + PostgreSQL schema, OIDC + local auth, Storage adapters (Local / S3 / Nextcloud), Helm chart skeleton
- [x] **Phase 2 — Core Inventory & Workflows:** Users, Companies, RBAC, Assets, Models, Custom Fields, Checkout/Checkin, EULA/Acceptance
- [x] **Phase 3 — Full Parity & REA Verification:** Licenses, Accessories, Consumables, Components, Kits, Audits, Maintenance, Depreciation, Reports, Importers, Labels, Self-service/Settings UI, and Piano 3.5 REA parity checks (`PLAN.md`, `docs/openapi.json`)
- [ ] **Phase 4 — Migration:** Snipe-IT MySQL → Kestrel-IT PostgreSQL data migration CLI & optional extensions

---

## Attribution & License

Kestrel-IT is inspired by and forked from the functional design of [**Snipe-IT**](https://github.com/grokability/snipe-it) (licensed under `AGPL-3.0-or-later`).
Kestrel-IT is distributed under [AGPL-3.0-or-later](LICENSE.md).
