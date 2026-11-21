# Kestrel-IT — Master Execution Plan (`PLAN.md`)

> Il piano segue le fasi di implementazione di Kestrel-IT. La [mappa funzionale di Snipe-IT](docs/08-upstream-feature-map.md) collega le funzionalità upstream alle specifiche e alle decisioni di parità.

---

## 🛠️ Stack & Toolchain Fissati

- **Node.js Runtime:** `v26.13.1` (LTS `lithium`, fissato in [`.nvmrc`](.nvmrc))
- **Package Manager:** `pnpm@12.21.0` (`packageManager: "pnpm@12.21.0"` con `pnpm-workspace.yaml`)
- **Backend (`apps/api`):** **NestJS** (con Fastify adapter `@nestjs/platform-fastify`), **Drizzle ORM**, **PostgreSQL 16+**, **In-Memory Cache**, **Scheduler (`@nestjs/schedule` + PostgreSQL Advisory Locks)**, **OpenAPI / Swagger**
- **Shared (`packages/shared`):** **TypeScript**, **Zod** (contratti DTO, validazione dinamica Custom Fields), **RBAC Enums & Matrix**
- **Frontend (`apps/web`):** **Angular** (Standalone Components, Signals, Reactive Forms, Server-Side DataGrid)
- **Deploy (`deploy/helm`):** **Single Helm Chart** Kubernetes + Docker multi-stage builds

---

## 📚 Indice delle Specifiche Tecniche (`docs/*`)

Prima di implementare qualsiasi modulo, consultare il documento corrispondente:

1. [`docs/00-architecture-overview.md`](docs/00-architecture-overview.md) — Architettura dei layer, struttura del monorepo e tracciamento REA (`reverse-engineer-anything`).
2. [`docs/01-database-schema-drizzle.md`](docs/01-database-schema-drizzle.md) — Schema completo PostgreSQL + Drizzle ORM (consolidamento delle 513 migrazioni e 53 modelli di Snipe-IT).
3. [`docs/02-custom-fields-jsonb-engine.md`](docs/02-custom-fields-jsonb-engine.md) — Motore Custom Fields & Fieldsets: da `ALTER TABLE _snipeit_*` a `JSONB` + indice GIN + validazione Zod + crittografia AES-256-GCM.
4. [`docs/03-rbac-policies-and-fmcs.md`](docs/03-rbac-policies-and-fmcs.md) — Matrice permessi, precedenza utente/gruppo, policy admin e isolamento Multi-Company (**FMCS**).
5. [`docs/04-domain-workflows-and-state.md`](docs/04-domain-workflows-and-state.md) — Macchine a stati e logica transazionale: Checkout/Checkin polimorfico, propagazione License Seats, EULA/Firme, Predefined Kits, Ammortamenti (Linear / Half-Year / Diminishing), Audit & Manutenzioni.
6. [`docs/05-api-contracts-and-modules.md`](docs/05-api-contracts-and-modules.md) — Mappatura dei 36 Controller API e 39 Transformer di Snipe-IT in moduli NestJS, contratti `/api/v1/*`, formato Datatables/Selectlist e calcolo `available_actions`.
7. [`docs/06-storage-auth-and-jobs.md`](docs/06-storage-auth-and-jobs.md) — Autenticazione locale/TOTP, OIDC, OAuth con PKCE, bridge Better Auth e PAT, Pluggable Storage (`Local`, `S3`, `Nextcloud WebDAV`), 12 tipi di importazione CSV, 26 Notifiche e Cron Jobs.
8. [`docs/07-frontend-angular-map.md`](docs/07-frontend-angular-map.md) — Architettura Angular SPA, mappatura schermate/rotte, DataGrid server-side, selettori asincroni company-aware e sostituzione dei 18 widget Livewire e di `snipeit.js`.
9. [`docs/08-upstream-feature-map.md`](docs/08-upstream-feature-map.md) — Comportamenti Snipe-IT, fonti, corrispondenze Kestrel-IT e stato di parità.

---

## 🚀 Piani Esecutivi per Fase

### ✅ FASE 0 — Reverse Engineering & Blueprint Architetturale (Completata)
- [x] Configurazione [`.nvmrc`](.nvmrc) (`v26.13.1`).
- [x] Analisi statica con REA (`analyze_javascript_application`) del bundle JS legacy di `../snipe-it/resources/assets/js` con [sintesi REA versionata](docs/rea-evidence-summary.json).
- [x] Prima mappatura di modelli, migrazioni, policy, transformer, servizi e rotte in `docs/00..07`. La [mappa funzionale](docs/08-upstream-feature-map.md) registra i comportamenti verificati e le decisioni di parità aperte.

---

### 🧱 FASE 1 — Foundation (Monorepo, Drizzle Schema, Auth, Storage, Helm Skeleton)
> **Riferimenti:** [`docs/00`](docs/00-architecture-overview.md), [`docs/01`](docs/01-database-schema-drizzle.md), [`docs/03`](docs/03-rbac-policies-and-fmcs.md), [`docs/06`](docs/06-storage-auth-and-jobs.md)

- [x] **Piano 1.1 — Setup Monorepo `pnpm`**
  - Creare `package.json` root (`"packageManager": "pnpm@12.21.0"`, `"engines": { "node": ">=22.0.0", "pnpm": ">=10.0.0" }`), `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.prettierrc`, `.prettierignore`, `.env.example`.
  - Creare `docker-compose.yml` di sviluppo (PostgreSQL 16 e MinIO per test S3, senza dipendenza da Redis).
- [x] **Piano 1.2 — Pacchetto Condiviso (`packages/shared`)**
  - Definire tutti gli enum di dominio (`StatusMetaType`, `CheckoutTargetType`, `ActionType`, `CustomFieldElement`, `CustomFieldFormat`, `DepreciationMethod`, `DepreciationType`, `CheckoutRequestState`, ecc.).
  - Definire la matrice completa dei permessi RBAC (`PermissionKey`, 87 permessi) e le funzioni pure (`hasAccess`, `resolveEffectivePermissions`, `canAccessCompanyRecord`, `resolveAssignedCompanyId`) usabili sia da NestJS che da Angular.
  - Definire gli schemi Zod base per paginazione (`DatatableQuerySchema`, `DatatableResponse`, `SelectlistQuerySchema`, `SelectlistResponseSchema`, `StandardApiResponse`, `AvailableActions`) e il compilatore dinamico Custom Fields (`buildCustomFieldZodSchema`, `buildFieldsetZodSchema`).
- [x] **Piano 1.3 — Scaffolding Backend NestJS + Drizzle ORM (`apps/api`)**
  - Inizializzare NestJS con `@nestjs/platform-fastify`, `@nestjs/config`, `@nestjs/swagger`, `@nestjs/schedule`, `@fastify/cookie`, `@fastify/multipart`.
  - Configurare `drizzle-orm` + `postgres` (`postgres.js`) e `drizzle-kit`.
  - Implementare tutti i file di schema Drizzle in `apps/api/src/db/schema/` (46 tabelle) come specificato in [`docs/01-database-schema-drizzle.md`](docs/01-database-schema-drizzle.md).
  - Generare la migrazione iniziale PostgreSQL (`apps/api/drizzle/0000_breezy_archangel.sql`) + implementare `DatabaseBootstrapService` per **Headless Bootstrap** (`BOOTSTRAP_ADMIN_*`), **Setup Wizard `/setup`** (`isSetupCompleted`) e seed `status_labels` base.
- [ ] **Piano 1.4 — Modulo Auth (Local + TOTP 2FA + OIDC con JIT Auto-Provisioning + PAT) & `SetupModule`**
  - [x] Implementare login locale (`scrypt` e verifica degli hash bcrypt `$2y$` di Snipe-IT), JWT (`jose`), TOTP con segreti cifrati, flusso OIDC con PKCE e provisioning JIT, PAT e rotte API di setup.
  - [ ] Verificare avvio dell'API compilata e flussi HTTP con PostgreSQL. Completare la verifica del collegamento OIDC, dell'applicazione della policy MFA ai flussi federati e della gestione delle sessioni.
- [ ] **Piano 1.4b — Estensione Auth: OAuth con PKCE S256 e Better Auth (`apps/api/src/modules/auth`)**
  - [x] Implementare il flusso Authorization Code con PKCE S256 e normalizzazione del profilo OAuth, il bridge di scambio Better Auth e i contratti condivisi.
  - [ ] Completare e verificare il bridge federato, la rotazione persistente dei refresh token e l'integrazione embedded di Better Auth con Drizzle, provider social/enterprise e passkey.
- [ ] **Piano 1.5 — Pluggable Storage Layer (`apps/api/src/common/storage`)**
  - Implementare l'interfaccia `StorageProvider` e i 3 adapter: `LocalStorageAdapter`, `S3StorageAdapter` (`@aws-sdk/client-s3`), `NextcloudWebDavAdapter`.
- [ ] **Piano 1.6 — Scaffolding Frontend Angular (`apps/web`) & Helm Chart (`deploy/helm`)**
  - Inizializzare Angular (Standalone, Signals, Routing, HttpClient con Auth Interceptor, Layout shell sidebar/topbar/breadcrumbs, rotta `/setup` con `SetupWizardComponent` e `setupGuard`).
  - Creare lo scheletro del singolo Helm Chart in `deploy/helm/kestrel-it` (`Chart.yaml`, `values.yaml`, deployment API & Web, Ingress, Secret, ConfigMap).

---

### 📦 FASE 2 — Core Inventory, Custom Fields JSONB & Lifecycle Workflows
> **Riferimenti:** [`docs/02`](docs/02-custom-fields-jsonb-engine.md), [`docs/03`](docs/03-rbac-policies-and-fmcs.md), [`docs/04`](docs/04-domain-workflows-and-state.md), [`docs/05`](docs/05-api-contracts-and-modules.md), [`docs/07`](docs/07-frontend-angular-map.md)

- [ ] **Piano 2.1 — Guards RBAC, FMCS Multi-Company Scoping & Core Entities**
  - Implementare `PermissionsGuard`, `@RequirePermission()`, e `FmcsScopeService` (supporto `full_multiple_companies_support`, gerarchia `parent_id` a 1 livello, `null_company_is_floater`, `scope_locations_fmcs`).
  - Moduli CRUD + `selectlist` + `bulk` (API + UI Angular):
    - `Companies`, `Groups`, `Users`
    - `Locations` (gerarchiche con breadcrumb `Parent › Child`), `Departments`
    - `Categories` (con EULA, `require_acceptance`, `checkin_email`), `Manufacturers`, `Suppliers`, `Statuslabels`
- [ ] **Piano 2.2 — Motore Custom Fields & Fieldsets (`JSONB`)**
  - CRUD `CustomFields` e `CustomFieldsets` + riordino + valori di default per `AssetModel` (`custom_field_defaults`).
  - Compilatore dinamico Zod in `CustomFieldsValidationService` (formati `ANY`, `ALPHA`, `NUMERIC`, `EMAIL`, `DATE`, `DATETIME`, `URL`, `IP`, `IPV4`, `IPV6`, `MAC`, `BOOLEAN`, `CUSTOM REGEX`).
  - Crittografia AES-256-GCM trasparente per i campi `field_encrypted = true` e mascheramento condizionato dal permesso `assets.view.encrypted_custom_fields`.
  - Componente Angular `CustomFieldFormSectionComponent` per rendering dinamico nei form Asset, Checkout, Checkin e Audit.
- [ ] **Piano 2.3 — Asset Models & Hardware Assets**
  - Modulo `AssetModels` (`/api/v1/models`): CRUD, clone, restore, associazione `fieldset_id`, `depreciation_id`, `eol`, `require_serial`, `requestable`.
  - Modulo `Assets` (`/api/v1/hardware`): CRUD, ricerca per tag (`bytag`), ricerca per seriale (`byserial`), auto-increment `asset_tag`, contatori, bulk edit/delete/restore, filtro avanzato su colonne standard e chiavi `custom_fields JSONB`, `SavedSearches`.
- [ ] **Piano 2.4 — Checkout / Checkin Polimorfico, EULA & Acceptance**
  - Implementare `AssetCheckoutService` in transazione Drizzle (`FOR UPDATE`):
    - Checkout a `User`, `Location` o altro `Asset`.
    - Aggiornamento `location_id` vs `rtd_location_id`.
    - Propagazione sicura dei `LicenseSeat` collegati all'asset (`propagateLicenseSeats`).
    - Incremento `checkout_counter` / `checkin_counter` e scrittura immutabile in `action_logs`.
  - Implementare `CheckoutAcceptances` & EULA: creazione richiesta accettazione, pagina utente `/account/accept`, firma su canvas HTML5, salvataggio PNG + generazione PDF EULA storicizzato (`stored_eula_file`), notifiche di accettazione/rifiuto.
  - Implementare `CheckoutRequests` (self-service `/account/requestable`).

---

### 🏆 FASE 3 — Full Parity (Secondary Inventory, Audits, Depreciation, Importers, Reports, Notifications)
> **Riferimenti:** [`docs/04`](docs/04-domain-workflows-and-state.md), [`docs/05`](docs/05-api-contracts-and-modules.md), [`docs/06`](docs/06-storage-auth-and-jobs.md), [`docs/07`](docs/07-frontend-angular-map.md)

- [ ] **Piano 3.1 — Inventario Secondario & Predefined Kits**
  - `Licenses` & `LicenseSeats` (checkout a User/Asset, mascheramento product key con permesso `licenses.keys`, `reassignable`, `unreassignable_seat`).
  - `Accessories` & `AccessoryCheckout` (checkout multiplo con note per singola assegnazione, `adjustQuantity` con metadati d'ordine `OrderItems`).
  - `Consumables` (consumo one-way, `adjustQuantity`, soglie `min_amt`).
  - `Components` (checkout con quantità parziale verso Asset, checkin parziale/totale).
  - `PredefinedKits` con checkout atomico. `PredefinedKitCheckoutService` acquisisce i lock `FOR UPDATE`, rivalida disponibilità e FMCS e annulla l'intero kit al fallimento di una voce. [Flusso](docs/04-domain-workflows-and-state.md#3-checkout-di-predefined-kits-predefinedkitcheckoutservicephp)
- [ ] **Piano 3.2 — Audits, Maintenances, Depreciation, Orders & Calendar**
  - `Asset Audits` (singolo e bulk, calcolo `next_audit_date`, upload foto audit).
  - `Maintenances` & `MaintenanceTypes` (ciclo apertura/completamento, note, costi, flag `is_warranty`).
  - `Depreciations` & `DepreciableService` (metodi `linear`, `half_1`, `half_2`, `diminish` con anno fiscale e `depreciation_min` fisso o percentuale).
  - `Orders` & `OrderItems` + `CalendarEvents` (`/api/v1/calendar/events`) + `LowStock` (`/api/v1/low-stock`).
- [ ] **Piano 3.3 — File Uploads, Generatore Etichette QR/Barcode & Reportistica**
  - `UploadedFilesController` (`/api/v1/{object_type}/{id}/files`) collegato a `StorageProvider`.
  - Motore di generazione Etichette PDF (`/api/v1/hardware/labels`, layout personalizzabili `CustomUserLabel`, QR Code 2D e Barcode 1D Code128/Code39).
  - 8+ Report (Activity, Custom Asset Report con `ReportTemplates`, Depreciation, License, Maintenance, Unaccepted Assets, Accessories, Audit) con export CSV/Excel.
- [ ] **Piano 3.4 — Motore CSV Importer (12 tipi), Notifiche (26) & Cron Jobs**
  - Importer CSV streaming con mappatura colonne (`field_map`) per tutti i 12 tipi di Snipe-IT.
  - Notifiche multi-canale (Email, Slack, Microsoft Teams, Google Chat / Generic Webhook) + webhook per singola Company.
  - Job schedulati giornalieri/settimanali (`inventory-alerts`, `expiring-alerts`, `expected-checkin`, `upcoming-audits`, `acceptance-reminders`).
- [ ] **Piano 3.5 — Verifica Formale di Parità con REA**
  - Esecuzione di `inspect_api_contract`, `build_reconstruction_obligation_ledger`, `evaluate_reconstruction_coverage` e `verify_reconstruction` per misurare la copertura delle funzionalità mappate. Verificare con test di contratto e di flusso i casi che richiedono evidenza a runtime.

---

### 🔄 FASE 4 — Migration CLI (Snipe-IT MySQL → Kestrel-IT PostgreSQL) & Estensioni Post-MVP
> **Riferimenti:** [`docs/01`](docs/01-database-schema-drizzle.md), [`docs/02`](docs/02-custom-fields-jsonb-engine.md)

- [ ] **Piano 4.1 — CLI di Migrazione `kestrel-migrate`**
  - Connessione read-only al database MySQL/MariaDB di Snipe-IT.
  - Migrazione lossless di tutte le tabelle core preservando gli ID primari.
  - Trasformazione automatica delle colonne dinamiche `assets._snipeit_<slug>_<id>` nel campo `assets.custom_fields` (`JSONB`) e ri-crittografia dei campi `field_encrypted`.
  - Migrazione dello storico `action_logs` e sincronizzazione file verso il backend Storage scelto.
- [ ] **Piano 4.2 — Estensioni Enterprise Post-MVP (Opzionali)**
  - Provisioning utenti/gruppi **SCIM 2.0**.
  - Connettori **SyncAdapters (MDM/RMM)** (Jamf, Intune, Fleet, Kandji, Apple Business Manager, ecc.).
  - Server **MCP** integrato per interrogazione AI dell'inventario.
