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

## Planned Monorepo Structure

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

The [Snipe-IT feature map](docs/08-upstream-feature-map.md) links observed upstream behavior to the planned Kestrel-IT equivalents and records open parity decisions.

## Database startup and Helm configuration

The API applies the checked-in Drizzle migrations before first-run setup. Replicas serialize migration and headless bootstrap through a PostgreSQL advisory lock. The Helm chart probes `/health` for liveness and `/ready` for database and schema readiness.

If the initial SQL was applied manually, apply the follow-up migration with `psql --single-transaction -v ON_ERROR_STOP=1 -f apps/api/drizzle/0001_auth_consumption_and_oidc.sql` and set `DB_AUTO_MIGRATE=false` (`config.dbAutoMigrate=false` in Helm). If the unique OIDC index reports duplicate active identities, reconcile those identities before retrying the migration. Existing refresh revocations with a future expiry are carried forward. [Migration](apps/api/drizzle/0001_auth_consumption_and_oidc.sql)

Provide production JWT and encryption keys through `config.secrets` or `config.existingSecret`, and supply `postgresql.auth.password` when using bundled PostgreSQL. Set `config.appUrl` to the public HTTPS origin used by the browser. The default local volume supports a single API replica. Use S3, Nextcloud, or a ReadWriteMany volume to scale past one.

## Roadmap

- [ ] **Phase 1 — Foundation:** Monorepo setup, Drizzle + PostgreSQL schema, OIDC + local auth, Storage adapters (Local / S3 / Nextcloud), Helm chart skeleton
- [ ] **Phase 2 — Core Inventory & Workflows:** Users, Companies, RBAC, Assets, Models, Custom Fields, Checkout/Checkin, EULA/Acceptance
- [ ] **Phase 3 — Full Parity:** Licenses, Accessories, Consumables, Components, Kits, Audits, Maintenance, Depreciation, Reports, Importers, Labels
- [ ] **Phase 4 — Migration:** Snipe-IT MySQL → Kestrel-IT PostgreSQL data migration CLI

---

## Attribution & License

Kestrel-IT is inspired by and forked from the functional design of [**Snipe-IT**](https://github.com/grokability/snipe-it) (licensed under `AGPL-3.0-or-later`).
License details for Kestrel-IT will be finalized in `LICENSE` prior to public release.
