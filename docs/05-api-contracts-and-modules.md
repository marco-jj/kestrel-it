# 05 — API Contracts, NestJS Modules & Transformers Mapping

Questo documento mappa l'intera superficie REST di Snipe-IT definita in [`../snipe-it/routes/api.php`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/api.php) (36 Controller API) e i **39 Transformer** in [`../snipe-it/app/Http/Transformers/`](https://github.com/grokability/snipe-it/tree/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers) nei moduli **NestJS** di Kestrel-IT (`apps/api/src/modules/*`).

---

## 1. Contratti di risposta Snipe-IT e obiettivo di compatibilità

### 1.1 Envelope Liste Paginate (`DatatablesTransformer`)
Tutti gli endpoint `GET /api/v1/<resource>` accettano `limit` (default `50`), `offset` (o `page`), `search`, `sort`, `order` (`'asc' | 'desc'`) e restituiscono:

```json
{
  "total": 142,
  "rows": [ ... ],
  "current_page": 1,
  "per_page": 50,
  "total_pages": 3,
  "prev_page_url": null,
  "next_page_url": "https://kestrel.example.com/api/v1/hardware?limit=50&page=2"
}
```

Con `total = 0` e un limite positivo, `total_pages` vale `0`, `rows` è vuoto e i link di paginazione sono nulli sulla prima pagina. [Transformer upstream](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/DatatablesTransformer.php#L10-L31)

### 1.2 Envelope Dropdown Asincroni (`SelectlistTransformer`)
Tutti gli endpoint `GET /api/v1/<resource>/selectlist` accettano `page`, `search`, `companyId` (per filtro FMCS), `statusType` e `includeNull=1` (che aggiunge in pagina 1 l'opzione `{ id: "null", text: "No value" }`), restituendo:

```json
{
  "results": [
    {
      "id": 12,
      "text": "Parent Location › Milan Office",
      "image": "https://kestrel.example.com/uploads/locations/milan.png",
      "tag_color": "#3b82f6",
      "disabled": false
    }
  ],
  "pagination": {
    "more": true,
    "per_page": 20
  },
  "total_count": 45,
  "page": 1,
  "page_count": 3
}
```

### 1.3 Envelope di Scrittura (`Helper::formatStandardApiResponse`)
Tutti gli endpoint `POST`, `PUT`, `PATCH`, `DELETE` restituiscono:

```json
{
  "status": "success",
  "messages": "Asset created successfully.",
  "payload": { ... }
}
```
In caso di errore di validazione: `status: "error"`, `messages: { "asset_tag": ["The asset tag has already been taken."] }`, `payload: null`.

### 1.4 Oggetto Date Formattato (`Helper::getFormattedDateObject`)
Ogni data/timestamp nei Transformer viene serializzata come oggetto `{ date | datetime, formatted }`:
```json
{
  "datetime": "2026-11-20 14:30:00",
  "formatted": "2026-11-20 02:30 PM"
}
```

### 1.5 Contratto `available_actions` per Guiding UI
Ogni riga restituita da un Transformer include l'oggetto `available_actions` calcolato sul chiamante autenticato:
```json
{
  "available_actions": {
    "checkout": true,
    "checkin": false,
    "clone": true,
    "restore": false,
    "update": true,
    "audit": true,
    "delete": true,
    "bulk_selectable": {
      "edit": true,
      "maintenance": true,
      "checkout": true,
      "checkin": false,
      "audit": true,
      "delete": true,
      "labels": true,
      "restore": false
    }
  }
}
```

---

## 2. Mappa dei Moduli NestJS ed Endpoint `/api/v1/*`

### Rotte di inventario disponibili dalla Fase 2

I percorsi sono relativi a `/api/v1`. La [mappa di progetto](#blueprint-di-parità) segue le rotte disponibili e include quelle previste nelle fasi successive. I permessi delle entità seguono la [matrice RBAC](03-rbac-policies-and-fmcs.md), con FMCS dove applicabile.

| Area | Rotte disponibili | Autorizzazione |
| :--- | :--- | :--- |
| Directory (`companies`, `groups`, `users`, `locations`, `departments`, `categories`, `manufacturers`, `suppliers`, `statuslabels`) | `GET/POST /<entity>`, `GET/PUT/PATCH/DELETE /<entity>/:id`, `GET /<entity>/selectlist`, `PATCH /<entity>/bulk`, `POST /<entity>/:id/restore` per record con soft-delete | `<entity>.view/create/edit/delete` secondo l'azione. Bulk edit richiede `edit`, bulk delete e restore richiedono `delete`. Gruppi visibili agli amministratori e modificabili solo dai superuser. Gli operatori delegati possono creare un destinatario di inventario (`inventory_only`), utilizzabile per checkout senza accesso all'applicazione. Attivazione per l'accesso, credenziali e modifiche a username o email esistenti richiedono un superuser. Anche i campi webhook aziendali sono riservati ai superuser. |
| Hardware e modelli | `GET/POST /hardware` e `/models`, `GET/PUT/PATCH/DELETE /hardware/:id` e `/models/:id`, `POST /hardware/:id/restore` e `/models/:id/restore`, `GET /hardware/bytag/:tag`, `/hardware/byserial/:serial`, `/hardware/custom-filter-fields`, `/hardware/form/:modelId`, `/hardware/:id/history`, `/models/:id/assets`, `/models/:id/history`, `POST /models/:id/clone`, `PATCH /hardware/bulk`, selectlist `/hardware`, `/models` e `/depreciations` | `assets.*` e `models.*` secondo l'operazione, con `assets.view.encrypted_custom_fields` per leggere in chiaro i valori cifrati. Il ripristino usa `delete`. |
| Custom fields e fieldset | `GET/POST /fields` e `/fieldsets`, `GET/PUT/PATCH/DELETE /fields/:id` e `/fieldsets/:id`, `GET /fields/selectlist` e `/fieldsets/selectlist`, `POST /fields/:id/associate`, `/fields/:id/disassociate`, `/fields/fieldsets/:id/order`, `/fieldsets/:id/fields`, `GET/POST /fieldsets/:id/fields/:model` | `customfields.view/create/edit/delete` per il catalogo, con permessi dei modelli per lettura e scrittura dei default. |
| Ricerche salvate | `GET/POST /saved-searches`, `GET/PUT/PATCH/DELETE /saved-searches/:id` | `assets.view` e proprietà della ricerca. |
| Checkout e check-in | `GET /hardware/targets/:type`, `POST /hardware/:id/checkout` e `/hardware/bytag/:tag/checkout`, `POST /hardware/:id/checkin`, `/hardware/bytag/:tag/checkin` e `/hardware/checkinbytag` | Chiavi `assets.checkout` e `assets.checkin` secondo l'operazione. Entrambe consentono il selettore `/hardware/targets/location`. I selettori ricevono `companyId` per restringere le opzioni compatibili con FMCS. Il valore `0` rappresenta un asset senza azienda. |
| Accettazione ed EULA | `GET /account/accept`, `GET/POST /account/accept/:id`, `GET /account/eulas`, `GET /account/accept/:id/eula` (PDF) e `/account/accept/:id/signature` (PNG) | Assegnatario o accesso autorizzato, con verifica FMCS. L'operatore che ha avviato la firma in presenza può raccogliere la risposta con `assets.checkout`. |
| Richieste personali | `GET /account/requestable/:type` (`hardware`, `models`, `accessories`, `consumables`, `components`, `licenses`), `GET /account/requests`, `POST /account/request/:id`, `POST /account/request/:type/:id`, `POST /account/requests/:id/cancel` e varianti `:item/cancel` per articolo | Permesso `assets.view.requestable` per catalogo e creazione, proprietà della richiesta per elenco e annullamento. |
| Coda operatore | `GET /requests`, `POST /requests/:id/fulfill`, `POST /requests/:id/cancel` | Chiave `assets.checkout` e visibilità FMCS. |

### Rotte disponibili dalla Fase 3.1 e 3.2

- **Inventario secondario e kit.** Le risorse `/licenses`, `/accessories`, `/consumables`, `/components` e `/kits` espongono CRUD e flussi di assegnazione. Il checkout riceve `target_type`, `target_id`, `quantity` e una nota facoltativa. Per i kit usare `user_id`. Il check-in dei componenti riceve l’ID dell’assegnazione nel path e una quantità facoltativa.
- **Audit.** `POST /hardware/audit`, `POST /hardware/:id/audit` e `POST /hardware/audit/bulk` accettano JSON o multipart con `payload` JSON e `photo` PNG/JPEG fino a 5 MB. Il bulk restituisce `results` per asset. `GET /hardware/:id/audits/:auditId/photo` scarica una foto autorizzata.
- **Manutenzione e ammortamento.** `/maintenances`, `/maintenance-types` e `/depreciations` espongono CRUD. Gli interventi e il completamento richiedono `assets.edit`, mentre la configurazione dei tipi richiede un superuser. Il dettaglio dell’asset e della licenza include `book_value` quando applicabile.
- **Acquisti, scorte e calendario.** `GET /order-items` accetta `item_type` e `item_id`, oppure `asset_model_id`. L’elenco senza filtri è riservato ai superuser. `GET /low-stock` usa il formato Datatable. `GET /calendar/events` accetta `start`, `end`, `event_type` e restituisce `events`, `total` e `truncated`. La risposta include solo sorgenti visibili al chiamante.

### Blueprint di parità

Questa mappa conserva i riferimenti ai controller Snipe-IT e la struttura prevista per Kestrel-IT. Per lo stato delle funzionalità consultare il [piano](../PLAN.md) e la [mappa di parità](08-upstream-feature-map.md).

| Modulo NestJS (`apps/api/src/modules/*`) | Controller & Transformer Snipe-IT | Endpoint REST (`/api/v1/...`) | Compiti Principali & Regole di Sicurezza |
| :--- | :--- | :--- | :--- |
| **`HardwareModule`** (`assets`) | [`Api\AssetsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/AssetsController.php)<br>[`AssetsTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/AssetsTransformer.php) | `GET/POST /hardware`<br>`GET/PUT/PATCH/DELETE /hardware/:id`<br>`PATCH /hardware/bulk`<br>`POST /hardware/:id/checkout`<br>`POST /hardware/:id/checkin`<br>`POST /hardware/:id/restore`<br>`POST /hardware/:id/audit`<br>`POST /hardware/audit/bulk`<br>`POST /hardware/labels`<br>`GET /hardware/selectlist`<br>`GET /hardware/bytag/:tag`<br>`POST /hardware/bytag/:tag/checkout`<br>`POST /hardware/bytag/:tag/checkin`<br>`POST /hardware/checkinbytag`<br>`GET /hardware/byserial/:serial`<br>`GET /hardware/:action/:upcoming_status`<br>`GET /hardware/:id/history`<br>`GET /hardware/:id/licenses`<br>`GET /hardware/:id/assigned/assets`<br>`GET /hardware/:id/assigned/accessories`<br>`GET /hardware/:id/assigned/components` | - Protezione PII su `assigned_to` se manca `users.view`<br>- Soppressione righe e decremento `total` su `/assigned/accessories` e `/assigned/components` se mancano `accessories.view` / `components.view`<br>- Mascheramento custom fields criptati se manca `assets.view.encrypted_custom_fields`. |
| **`AssetModelsModule`** (`models`) | [`Api\AssetModelsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/AssetModelsController.php)<br>[`AssetModelsTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/AssetModelsTransformer.php) | `GET/POST /models`<br>`GET/PUT/PATCH/DELETE /models/:id`<br>`POST /models/:id/restore`<br>`GET /models/selectlist`<br>`GET /models/:id/assets`<br>`GET /models/:id/history` | Gestisce l'associazione con `CustomFieldset`, `Depreciation`, `Category`, `Manufacturer` e valori default dei Custom Fields. |
| **`CustomFieldsModule`** (`fields`, `fieldsets`) | [`Api\CustomFieldsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/CustomFieldsController.php)<br>[`Api\CustomFieldsetsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/CustomFieldsetsController.php)<br>[`CustomFieldsTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/CustomFieldsTransformer.php)<br>[`CustomFieldsetsTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/CustomFieldsetsTransformer.php) | `GET/POST /fields`<br>`GET/PUT/PATCH/DELETE /fields/:id`<br>`POST /fields/:field/associate`<br>`POST /fields/:field/disassociate`<br>`POST /fields/fieldsets/:id/order`<br>`GET/POST /fieldsets`<br>`GET/PUT/PATCH/DELETE /fieldsets/:id`<br>`POST /fieldsets/:fieldset/fields`<br>`POST /fieldsets/:fieldset/fields/:model` | Gestisce il catalogo campi, l'ordine nei fieldset, l'obbligatorietà (`required`) e i `custom_field_defaults` per modello. |
| **`LicensesModule`** (`licenses`) | [`Api\LicensesController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/LicensesController.php)<br>[`Api\LicenseSeatsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/LicenseSeatsController.php)<br>[`LicensesTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/LicensesTransformer.php)<br>[`LicenseSeatsTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/LicenseSeatsTransformer.php) | `GET/POST /licenses`<br>`GET/PUT/PATCH/DELETE /licenses/:id`<br>`GET /licenses/selectlist`<br>`GET /licenses/:id/history`<br>`POST /licenses/:id/checkout`<br>`POST /licenses/:id/checkin`<br>`GET /licenses/:id/seats`<br>`GET/PUT/PATCH /licenses/:id/seats/:seatId` | Auto-genera/sincronizza il numero di righe in `license_seats` al variare di `license.seats`. Maschera `serial` se manca `licenses.keys`. |
| **`AccessoriesModule`** (`accessories`) | [`Api\AccessoriesController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/AccessoriesController.php)<br>[`AccessoriesTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/AccessoriesTransformer.php) | `GET/POST /accessories`<br>`GET/PUT/PATCH/DELETE /accessories/:id`<br>`GET /accessories/selectlist`<br>`GET /accessories/:id/history`<br>`GET /accessories/:id/checkedout`<br>`POST /accessories/:id/checkout`<br>`POST /accessories/:id/checkin`<br>`POST /accessories/:id/adjust-quantity`<br>`POST /accessories/:id/restore`<br>`POST /accessories/:id/unarchive`<br>`POST /accessories/bulkedit\|bulkdelete\|bulkrestore` | Supporta checkout verso `User`, `Asset` o `Location` (con quantità e nota), checkin per `accessory_checkout_id` e `adjust-quantity`. |
| **`ConsumablesModule`** (`consumables`) | [`Api\ConsumablesController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/ConsumablesController.php)<br>[`ConsumablesTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/ConsumablesTransformer.php) | `GET/POST /consumables`<br>`GET/PUT/PATCH/DELETE /consumables/:id`<br>`GET /consumables/selectlist`<br>`GET /consumables/:id/history`<br>`GET /consumables/:id/users`<br>`POST /consumables/:id/checkout`<br>`POST /consumables/:id/adjust-quantity`<br>`POST /consumables/:id/consume/:assignment`<br>`POST /consumables/bulkconsume\|bulkedit\|bulkdelete\|bulkrestore` | Assegnazione consumabili agli utenti, consumo definitivo e aggiustamento scorte. |
| **`ComponentsModule`** (`components`) | [`Api\ComponentsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/ComponentsController.php)<br>[`ComponentsTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/ComponentsTransformer.php) | `GET/POST /components`<br>`GET/PUT/PATCH/DELETE /components/:id`<br>`GET /components/:id/history`<br>`GET /components/:id/assets`<br>`POST /components/:id/checkout`<br>`POST /components/:pivotId/checkin`<br>`POST /components/:id/adjust-quantity`<br>`POST /components/bulkedit\|bulkdelete\|bulkrestore` | Checkout di quantità parziali verso un `Asset` e checkin parziale o totale dal pivot `components_assets`. |
| **`PredefinedKitsModule`** (`kits`) | [`Api\PredefinedKitsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/PredefinedKitsController.php)<br>[`PredefinedKitsTransformer`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Transformers/PredefinedKitsTransformer.php) | `GET/POST /kits`<br>`GET/PUT/PATCH/DELETE /kits/:id`<br>`GET/POST/PUT/DELETE /kits/:id/models`<br>`GET/POST/PUT/DELETE /kits/:id/licenses`<br>`GET/POST/PUT/DELETE /kits/:id/accessories`<br>`GET/POST/PUT/DELETE /kits/:id/consumables`<br>`POST /kits/:id/checkout` | Gestione composizione del kit e checkout verso un `User`. In caso di contesa, un conflitto su qualsiasi voce annulla l’intero checkout. [Flusso atomico](04-domain-workflows-and-state.md#3-checkout-di-predefined-kits-predefinedkitcheckoutservicephp). |
| **`UsersModule` & `GroupsModule`** | [`Api\UsersController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/UsersController.php)<br>[`Api\GroupsController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/GroupsController.php)<br>[`Api\ProfileController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/ProfileController.php) | `GET/POST /users`, `GET/PUT/PATCH/DELETE /users/:id`<br>`GET /users/me`, `GET /users/selectlist`<br>`GET /users/:id/assets\|accessories\|consumables\|licenses\|eulas\|history`<br>`POST /users/:id/email`, `POST /users/:id/restore`<br>`GET/POST /groups`, `GET/PUT/PATCH/DELETE /groups/:id`, `GET /groups/selectlist`<br>`GET /account/assets\|requests\|eulas`<br>`GET/POST /account/personal-access-tokens`<br>`DELETE /account/personal-access-tokens/:tokenId`<br>`GET /account/requestable/:type`<br>`POST /account/request/...` | Gestione utenti, appartenenza `company_user` e `users_groups`, self-service portal, PAT tokens e invio riepilogo inventario via email. |
| **`TaxonomyModule`** (`categories`, `companies`, `departments`, `locations`, `manufacturers`, `suppliers`, `statuslabels`, `depreciations`) | 8 Controller API + 8 Transformer dedicati | `GET/POST /<entity>`<br>`GET/PUT/PATCH/DELETE /<entity>/:id`<br>`GET /<entity>/selectlist`<br>Rotte extra per `locations/:id/assets`, `locations/:id/assigned/*`, `statuslabels/assets/name`, `statuslabels/assets/type`, `statuslabels/:id/deployable` | CRUD completo, validazione integrità referenziale prima della cancellazione (`isDeletable()`), formattazione gerarchica `indenter()` (`Parent › Child`) per `companies` e `locations`. |
| **`MaintenancesModule`** | [`Api\MaintenancesController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/MaintenancesController.php)<br>[`Api\MaintenanceTypesController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/Api/MaintenanceTypesController.php) | `GET/POST /maintenances`, `GET/PUT/PATCH/DELETE /maintenances/:id`<br>`POST /maintenances/:id/complete`<br>`GET/POST /maintenances/:id/notes`<br>`GET /maintenances/:id/history`<br>`GET/POST/PUT/DELETE /maintenance-types`, `GET /maintenance-types/selectlist` | Tracciamento interventi di manutenzione su Asset, completamento con nota e storico. |
| **`OperationsModule`** (`files`, `notes`, `imports`, `labels`, `reports`, `dashboard`, `calendar`, `low-stock`, `saved-searches`, `settings`, `order-items`, `unaccepted-acceptances`) | 13 Controller API + Transformer dedicati | `GET /:object_type/:id/files` (lista)<br>`GET /:object_type/:id/files/:file_id` (download)<br>`POST /:object_type/:id/files` (upload)<br>`DELETE /:object_type/:id/files/:file_id/delete`<br>`GET/POST /notes/:asset/*`<br>`GET/POST/DELETE /imports`, `POST /imports/process/:id`<br>`GET /labels`, `GET /labels/:name`<br>`GET /reports/activity`, `GET /reports/activity/chart`, `GET /reports/depreciation`<br>`GET /dashboard/activity\|categories\|companies\|locations`<br>`GET /calendar/events`, `GET /low-stock`, `GET /order-items`<br>`GET/POST /unaccepted-acceptances/*`<br>`GET/POST/PUT/DELETE /saved-searches`<br>`GET/POST/PUT/PATCH /settings/*`, `GET /version` | Upload/download allegati polimorfici, note, import CSV, grafici dashboard, calendario unificato, solleciti EULA non accettate e configurazione sistema. |
| **`SetupModule`** (`setup`) | [`SetupController`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Controllers/SetupController.php)<br>[`CheckForSetup`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Http/Middleware/CheckForSetup.php) | `GET /setup/status`<br>`POST /setup/complete` | Diagnostica Pre-Flight (DB, Drizzle, Storage, OIDC, SMTP) e creazione primo Superuser + `settings` + `status_labels` base. Protetto da `SetupNotCompletedGuard`: bloccato permanentemente con `403 Forbidden` appena `setupCompleted === true`. |

### Rotte compatibili da preservare

- [Allegati](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/api.php#L1659-L1693). L'elenco dei tipi di risorsa ammessi dipende dall'operazione. Snipe-IT accetta anche l'alias `assets` per `hardware`.
- [Check-in per asset tag](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/api.php#L676-L688). Il client può inviare il tag nel percorso o usare la rotta `/hardware/checkinbytag`.
- [Revoca del token personale](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/api.php#L150-L169). Il token da revocare è identificato nel percorso.
- [Backup](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/api.php#L1187-L1206). Snipe-IT espone elenco e download dei backup in `/api/v1/settings/backups`. In Kestrel-IT backup e ripristino sono delegati a responsabilità operativa esterna (snapshot PostgreSQL/WAL e storage oggetti); non sono esposti endpoint applicativi sotto `/api/v1/settings/backups` (`disposition: "external"` in [rea-coverage-manifest.json](rea-coverage-manifest.json)).

### Contratti operativi dei Piani 3.3 e 3.4 e verifica Piano 3.5

- **Allegati.** `GET/POST /{object_type}/:id/files`, `GET /{object_type}/:id/files/:file_id` e `DELETE /{object_type}/:id/files/:file_id/delete`. Gli upload accettano campi multipart `file` e `notes`. Il download passa dal controller autenticato.
- **Etichette.** `GET /labels`, `GET /labels/:name` e `GET /labels/:id` gestiscono i preset e i template personalizzati (`PUT/PATCH/DELETE` per i template salvati). Il superuser può scrivere template e richiedere `POST /labels/preview`. `POST /hardware/labels` accetta `asset_tags`, `template` e `skipped`. La modalità predefinita restituisce `payload.pdf` in base64. `format: "pdf"` restituisce direttamente il PDF.
- **Report.** `GET /reports/:type` restituisce i risultati paginati e le colonne disponibili. `format=csv` e `format=xlsx` usano gli stessi filtri. `GET /reports/activity/chart` aggrega per giorno. `GET /dashboard/activity` usa la vista con scope per risorsa. I template si gestiscono in `/report-templates` (`/report-templates/:id`) e i solleciti in `POST /unaccepted-acceptances/send-reminders` (`GET /unaccepted-acceptances`).
- **Import.** `POST /imports` accetta più file CSV. `GET /imports/:id?import_type=...` restituisce anteprima e mappatura suggerita. `POST /imports/process/:id` accoda il lavoro con `import_type`, `field_map` (indice CSV a campo), `update_existing`, `preserve_blanks` e `send_welcome`. `GET /imports/:id/progress` restituisce lo stato e gli errori paginati. Download (`GET /imports/:id/download`) e cancellazione seguono lo scope del proprietario.
- **Notifiche e Profilo/Sicurezza.** `GET/PATCH /settings/notifications` gestisce alert ed endpoint webhook globali; `POST /settings/notifications/test` accoda il messaggio di prova; `POST /users/:id/email` invia il riepilogo al destinatario. `GET/PATCH /settings`, `GET /settings/login-attempts` e `GET/PATCH /account/profile` coprono impostazioni, registro accessi e profilo/password self-service.
- **Verifica OpenAPI Piano 3.5.** Il contratto generato in [openapi.json](openapi.json) (`299` path, `435` operazioni inline) è stato inventariato con `inspect_api_contract` (`api_contract_18a80c475ba6de08edd152c3db43628f035859e05da8932474562b8c4d4bc3ca`) e verificato su tutti i boundary in [rea-coverage-manifest.json](rea-coverage-manifest.json).
