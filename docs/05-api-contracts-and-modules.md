# 05 — API Contracts, NestJS Modules & Transformers Mapping

Questo documento mappa l'intera superficie REST di Snipe-IT definita in [`../snipe-it/routes/api.php`](file:///Users/thor/development/snipe-it/routes/api.php) (36 Controller API) e i **39 Transformer** in [`../snipe-it/app/Http/Transformers/`](file:///Users/thor/development/snipe-it/app/Http/Transformers) nei moduli **NestJS** di Kestrel-IT (`apps/api/src/modules/*`).

---

## 1. Contratti Standard di Risposta API (100% Compatibili con Snipe-IT)

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

## 2. Mappa Completa dei Moduli NestJS ed Endpoint `/api/v1/*`

| Modulo NestJS (`apps/api/src/modules/*`) | Controller & Transformer Snipe-IT | Endpoint REST (`/api/v1/...`) | Compiti Principali & Regole di Sicurezza |
| :--- | :--- | :--- | :--- |
| **`HardwareModule`** (`assets`) | [`Api\AssetsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/AssetsController.php)<br>[`AssetsTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/AssetsTransformer.php) | `GET/POST /hardware`<br>`GET/PUT/PATCH/DELETE /hardware/:id`<br>`PATCH /hardware/bulk`<br>`POST /hardware/:id/checkout`<br>`POST /hardware/:id/checkin`<br>`POST /hardware/:id/restore`<br>`POST /hardware/:id/audit`<br>`POST /hardware/audit/bulk`<br>`POST /hardware/labels`<br>`GET /hardware/selectlist`<br>`GET /hardware/bytag/:tag`<br>`POST /hardware/bytag/:tag/checkout`<br>`POST /hardware/bytag/:tag/checkin`<br>`GET /hardware/byserial/:serial`<br>`GET /hardware/:action/:upcoming_status`<br>`GET /hardware/:id/history`<br>`GET /hardware/:id/licenses`<br>`GET /hardware/:id/assigned/assets`<br>`GET /hardware/:id/assigned/accessories`<br>`GET /hardware/:id/assigned/components` | - Protezione PII su `assigned_to` se manca `users.view`<br>- Soppressione righe e decremento `total` su `/assigned/accessories` e `/assigned/components` se mancano `accessories.view` / `components.view`<br>- Mascheramento custom fields criptati se manca `assets.view.encrypted_custom_fields`. |
| **`AssetModelsModule`** (`models`) | [`Api\AssetModelsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/AssetModelsController.php)<br>[`AssetModelsTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/AssetModelsTransformer.php) | `GET/POST /models`<br>`GET/PUT/PATCH/DELETE /models/:id`<br>`POST /models/:id/restore`<br>`GET /models/selectlist`<br>`GET /models/:id/assets`<br>`GET /models/:id/history` | Gestisce l'associazione con `CustomFieldset`, `Depreciation`, `Category`, `Manufacturer` e valori default dei Custom Fields. |
| **`CustomFieldsModule`** (`fields`, `fieldsets`) | [`Api\CustomFieldsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/CustomFieldsController.php)<br>[`Api\CustomFieldsetsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/CustomFieldsetsController.php)<br>[`CustomFieldsTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/CustomFieldsTransformer.php)<br>[`CustomFieldsetsTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/CustomFieldsetsTransformer.php) | `GET/POST /fields`<br>`GET/PUT/PATCH/DELETE /fields/:id`<br>`POST /fields/:field/associate`<br>`POST /fields/:field/disassociate`<br>`POST /fields/fieldsets/:id/order`<br>`GET/POST /fieldsets`<br>`GET/PUT/PATCH/DELETE /fieldsets/:id`<br>`POST /fieldsets/:fieldset/fields`<br>`POST /fieldsets/:fieldset/fields/:model` | Gestisce il catalogo campi, l'ordine nei fieldset, l'obbligatorietà (`required`) e i `custom_field_defaults` per modello. |
| **`LicensesModule`** (`licenses`) | [`Api\LicensesController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/LicensesController.php)<br>[`Api\LicenseSeatsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/LicenseSeatsController.php)<br>[`LicensesTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/LicensesTransformer.php)<br>[`LicenseSeatsTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/LicenseSeatsTransformer.php) | `GET/POST /licenses`<br>`GET/PUT/PATCH/DELETE /licenses/:id`<br>`GET /licenses/selectlist`<br>`GET /licenses/:id/history`<br>`POST /licenses/:id/checkout`<br>`POST /licenses/:id/checkin`<br>`GET /licenses/:id/seats`<br>`GET/PUT/PATCH /licenses/:id/seats/:seatId` | Auto-genera/sincronizza il numero di righe in `license_seats` al variare di `license.seats`. Maschera `serial` se manca `licenses.keys`. |
| **`AccessoriesModule`** (`accessories`) | [`Api\AccessoriesController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/AccessoriesController.php)<br>[`AccessoriesTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/AccessoriesTransformer.php) | `GET/POST /accessories`<br>`GET/PUT/PATCH/DELETE /accessories/:id`<br>`GET /accessories/selectlist`<br>`GET /accessories/:id/history`<br>`GET /accessories/:id/checkedout`<br>`POST /accessories/:id/checkout`<br>`POST /accessories/:id/checkin`<br>`POST /accessories/:id/adjust-quantity`<br>`POST /accessories/:id/restore`<br>`POST /accessories/:id/unarchive`<br>`POST /accessories/bulkedit\|bulkdelete\|bulkrestore` | Supporta checkout verso `User`, `Asset` o `Location` (con quantità e nota), checkin per `accessory_checkout_id` e `adjust-quantity`. |
| **`ConsumablesModule`** (`consumables`) | [`Api\ConsumablesController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/ConsumablesController.php)<br>[`ConsumablesTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/ConsumablesTransformer.php) | `GET/POST /consumables`<br>`GET/PUT/PATCH/DELETE /consumables/:id`<br>`GET /consumables/selectlist`<br>`GET /consumables/:id/history`<br>`GET /consumables/:id/users`<br>`POST /consumables/:id/checkout`<br>`POST /consumables/:id/adjust-quantity`<br>`POST /consumables/:id/consume/:assignment`<br>`POST /consumables/bulkconsume\|bulkedit\|bulkdelete\|bulkrestore` | Assegnazione consumabili agli utenti, consumo definitivo e aggiustamento scorte. |
| **`ComponentsModule`** (`components`) | [`Api\ComponentsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/ComponentsController.php)<br>[`ComponentsTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/ComponentsTransformer.php) | `GET/POST /components`<br>`GET/PUT/PATCH/DELETE /components/:id`<br>`GET /components/:id/history`<br>`GET /components/:id/assets`<br>`POST /components/:id/checkout`<br>`POST /components/:pivotId/checkin`<br>`POST /components/:id/adjust-quantity`<br>`POST /components/bulkedit\|bulkdelete\|bulkrestore` | Checkout di quantità parziali verso un `Asset` e checkin parziale o totale dal pivot `components_assets`. |
| **`PredefinedKitsModule`** (`kits`) | [`Api\PredefinedKitsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/PredefinedKitsController.php)<br>[`PredefinedKitsTransformer`](file:///Users/thor/development/snipe-it/app/Http/Transformers/PredefinedKitsTransformer.php) | `GET/POST /kits`<br>`GET/PUT/PATCH/DELETE /kits/:id`<br>`GET/POST/PUT/DELETE /kits/:id/models`<br>`GET/POST/PUT/DELETE /kits/:id/licenses`<br>`GET/POST/PUT/DELETE /kits/:id/accessories`<br>`GET/POST/PUT/DELETE /kits/:id/consumables`<br>`POST /kits/:id/checkout` | Gestione composizione del kit e checkout transazionale atomico verso un `User`. |
| **`UsersModule` & `GroupsModule`** | [`Api\UsersController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/UsersController.php)<br>[`Api\GroupsController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/GroupsController.php)<br>[`Api\ProfileController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/ProfileController.php) | `GET/POST /users`, `GET/PUT/PATCH/DELETE /users/:id`<br>`GET /users/me`, `GET /users/selectlist`<br>`GET /users/:id/assets\|accessories\|consumables\|licenses\|eulas\|history`<br>`POST /users/:id/email`, `POST /users/:id/restore`<br>`GET/POST /groups`, `GET/PUT/PATCH/DELETE /groups/:id`, `GET /groups/selectlist`<br>`GET /account/assets\|requests\|eulas`<br>`GET/POST/DELETE /account/personal-access-tokens`<br>`GET /account/requestable/:type`<br>`POST /account/request/...` | Gestione utenti, appartenenza `company_user` e `users_groups`, self-service portal, PAT tokens e invio riepilogo inventario via email. |
| **`TaxonomyModule`** (`categories`, `companies`, `departments`, `locations`, `manufacturers`, `suppliers`, `statuslabels`, `depreciations`) | 8 Controller API + 8 Transformer dedicati | `GET/POST /<entity>`<br>`GET/PUT/PATCH/DELETE /<entity>/:id`<br>`GET /<entity>/selectlist`<br>Rotte extra per `locations/:id/assets`, `locations/:id/assigned/*`, `statuslabels/assets/name`, `statuslabels/assets/type`, `statuslabels/:id/deployable` | CRUD completo, validazione integrità referenziale prima della cancellazione (`isDeletable()`), formattazione gerarchica `indenter()` (`Parent › Child`) per `companies` e `locations`. |
| **`MaintenancesModule`** | [`Api\MaintenancesController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/MaintenancesController.php)<br>[`Api\MaintenanceTypesController`](file:///Users/thor/development/snipe-it/app/Http/Controllers/Api/MaintenanceTypesController.php) | `GET/POST /maintenances`, `GET/PUT/PATCH/DELETE /maintenances/:id`<br>`POST /maintenances/:id/complete`<br>`GET/POST /maintenances/:id/notes`<br>`GET /maintenances/:id/history`<br>`GET/POST/PUT/DELETE /maintenance-types`, `GET /maintenance-types/selectlist` | Tracciamento interventi di manutenzione su Asset, completamento con nota e storico. |
| **`OperationsModule`** (`files`, `notes`, `imports`, `labels`, `reports`, `dashboard`, `calendar`, `low-stock`, `saved-searches`, `settings`, `order-items`, `unaccepted-acceptances`) | 13 Controller API + Transformer dedicati | `GET/POST/DELETE /:object_type/:id/files`<br>`GET/POST /notes/:asset/*`<br>`GET/POST/DELETE /imports`, `POST /imports/process/:id`<br>`GET /labels`, `GET /labels/:name`<br>`GET /reports/activity`, `GET /reports/activity/chart`, `GET /reports/depreciation`<br>`GET /dashboard/activity\|categories\|companies\|locations`<br>`GET /calendar/events`, `GET /low-stock`, `GET /order-items`<br>`GET/POST /unaccepted-acceptances/*`<br>`GET/POST/PUT/DELETE /saved-searches`<br>`GET/POST/PUT/PATCH /settings/*`, `GET /version` | Upload/download allegati polimorfici, note, import CSV, grafici dashboard, calendario unificato, solleciti EULA non accettate e configurazione sistema. |
