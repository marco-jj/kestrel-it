# 03 — RBAC Policies, Permissions & Multi-Company Scoping (FMCS)

Questo documento mappa l'intero sistema di autorizzazione di Snipe-IT — definito in [`config/permissions.php`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/config/permissions.php), nelle **24 Policy** in [`app/Policies/`](https://github.com/grokability/snipe-it/tree/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Policies) e nella logica **FMCS (Full Multiple Company Support)** di [`app/Models/Company.php`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Models/Company.php) — traducendolo in **NestJS Guards** e **Drizzle Query Scopes** per Kestrel-IT.

---

## 1. Catalogo Completo dei Permessi (`packages/shared/src/rbac/permissions.ts`)

Estratto integralmente da [`../snipe-it/config/permissions.php`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/config/permissions.php):

| Area / Gruppo | Chiavi di Permesso (`PermissionKey`) | Note e Regole Speciali |
| :--- | :--- | :--- |
| **Global Roles** | `superuser`, `admin` | `superuser` bypassa qualsiasi controllo (incluso FMCS). `admin` concede tutte le azioni sulle entità ma **resta vincolato a FMCS** (vedi [`SnipePermissionsPolicy::before`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Policies/SnipePermissionsPolicy.php#L38-L54)). |
| **System Operations** | `import`, `reports.view` | `import` abilita l'uso del motore CSV Importer; `reports.view` abilita i report e l'export. |
| **Assets (`hardware`)** | `assets.view`, `assets.create`, `assets.edit`, `assets.delete`, `assets.checkout`, `assets.checkin`, `assets.audit`, `assets.view.encrypted_custom_fields`, `assets.files`, `assets.view.requestable` | `clone` non è un permesso a sé: è composto da `assets.view && assets.create`. `delete` richiede inoltre che l'asset non sia eliminato (`deleted_at IS NULL`) e non sia attualmente assegnato (`assigned_to IS NULL`). |
| **Accessories** | `accessories.view`, `accessories.create`, `accessories.edit`, `accessories.delete`, `accessories.checkout`, `accessories.checkin`, `accessories.files` | Estende `CheckoutablePermissionsPolicy`. |
| **Consumables** | `consumables.view`, `consumables.create`, `consumables.edit`, `consumables.delete`, `consumables.checkout`, `consumables.files` | I consumabili non hanno `checkin` (flusso one-way). |
| **Licenses** | `licenses.view`, `licenses.create`, `licenses.edit`, `licenses.delete`, `licenses.checkout`, `licenses.checkin`, `licenses.keys`, `licenses.files` | Senza `licenses.keys`, il campo `serial` (Product Key) viene mascherato con `License::PRODUCT_KEY_MASK` (`"***************"`). |
| **Components** | `components.view`, `components.create`, `components.edit`, `components.delete`, `components.checkout`, `components.checkin`, `components.files` | Include controllo anti-info-disclosure quando elencati sotto un Asset (`AssetsTransformer::transformCheckedoutComponents`). |
| **Predefined Kits** | `kits.view`, `kits.create`, `kits.edit`, `kits.delete` | Durante il checkout di un kit, viene verificato anche il permesso `.checkout` su ciascun Asset, Licenza, Consumabile e Accessorio contenuto nel kit. |
| **Users** | `users.view`, `users.create`, `users.edit`, `users.delete`, `users.files` | Include protezione PII in `AssetsTransformer::transformAssignedTo`: chi ha `assets.view` ma non `users.view` vede solo `{ id, type: 'user', name }` senza `email`, `username`, `employee_number`, `jobtitle`. |
| **Asset Models** | `models.view`, `models.create`, `models.edit`, `models.delete`, `models.files` | `AssetModelPolicy` distingue `files` (lettura, permessa anche a chi ha `assets.view`) da `manageFiles` (scrittura/cancellazione, richiede `models.files`). |
| **Categories** | `categories.view`, `categories.create`, `categories.edit`, `categories.delete` | Non può essere cancellata se ha modelli, accessori, consumabili, componenti o licenze collegati. |
| **Departments** | `departments.view`, `departments.create`, `departments.edit`, `departments.delete`, `departments.files` | — |
| **Status Labels** | `statuslabels.view`, `statuslabels.create`, `statuslabels.edit`, `statuslabels.delete` | Non può essere cancellata se associata ad Asset. |
| **Custom Fields** | `customfields.view`, `customfields.create`, `customfields.edit`, `customfields.delete` | Vale sia per `CustomField` sia per `CustomFieldset`. Un `CustomField` non può essere eliminato se appartiene a un `CustomFieldset` (`fieldset_count === 0`). |
| **Suppliers** | `suppliers.view`, `suppliers.create`, `suppliers.edit`, `suppliers.delete`, `suppliers.files` | — |
| **Manufacturers** | `manufacturers.view`, `manufacturers.create`, `manufacturers.edit`, `manufacturers.delete` | — |
| **Depreciations** | `depreciations.view`, `depreciations.create`, `depreciations.edit`, `depreciations.delete` | — |
| **Locations** | `locations.view`, `locations.create`, `locations.edit`, `locations.delete`, `locations.files` | Non può essere cancellata se ha figli, utenti o asset collegati. |
| **Companies** | `companies.view`, `companies.create`, `companies.edit`, `companies.delete`, `companies.files` | I campi webhook di una Company (`webhook_selected`, `webhook_endpoint`, `webhook_channel`, `webhook_botname`) sono modificabili **solo da `superuser`**. |
| **Self / User Profile** | `self.two_factor`, `self.api`, `self.edit_location`, `self.checkout_assets`, `self.view_purchase_cost`, `assets.view.requestable` | `self.api` controlla la creazione/revoca dei Personal Access Tokens. |

---

## 2. Decisioni di autorizzazione in Snipe-IT

- Il controllo della singola chiave concede sempre la richiesta al superuser. Negli altri casi un grant esplicito (`1`) o un deny esplicito (`-1`) dell'utente ha la precedenza. Una chiave assente o impostata a `0` eredita eventuali grant dei gruppi. [`User::hasAccess()`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Models/User.php#L936-L993)
- L'override admin concede le operazioni gestite dalle policy sulle entità. L'admin resta soggetto al filtraggio aziendale applicato nelle query. I controlli chiamati direttamente tramite `hasAccess()` continuano a valutare la chiave richiesta. [`SnipePermissionsPolicy::before()`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Policies/SnipePermissionsPolicy.php#L38-L71)
- Lo scope FMCS filtra le query, con regole specifiche per aziende, utenti, sedi e storico attività. [`Company::scopeCompanyablesDirectly()`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Models/Company.php#L749-L867)

### Mappatura Kestrel-IT

Questo riferimento TypeScript specifica il comportamento da implementare nel Piano 2.1. L'attuale `hasAccess` condivisa include l'override `admin` nel controllo della chiave. Il chiamante passa a `hasEntityPolicyAccess` l'esito dello scope FMCS della risorsa e applica le eventuali regole della policy specializzata. Anche le query di lista e di lookup devono applicare lo scope. [Valutatore attuale](../packages/shared/src/rbac/evaluate-permission.ts), [Piano 2.1](../PLAN.md)

```ts
import { isSuperUser, type PermissionKey, type PermissionMap } from '@kestrel-it/shared';

function hasKeyAccess(
  user: PermissionMap,
  groups: PermissionMap[],
  key: PermissionKey,
): boolean {
  if (isSuperUser(user, groups)) return true;

  const direct = user[key];
  if (direct === 1 || direct === -1) return direct === 1;

  return groups.some((group) => group[key] === 1);
}

function hasEntityPolicyAccess(
  user: PermissionMap,
  groups: PermissionMap[],
  key: PermissionKey,
  visibleUnderFmcs: boolean,
): boolean {
  if (isSuperUser(user, groups)) return true;
  if (!visibleUnderFmcs) return false;

  return hasKeyAccess(user, groups, 'admin') || hasKeyAccess(user, groups, key);
}
```

Con queste regole un deny utente prevale sul grant del gruppo nel controllo della chiave. Per un admin, la policy standard concede l'azione su una risorsa visibile anche in presenza di quel deny. Fuori dallo scope FMCS la risorsa resta inaccessibile all'admin.

---

## 3. Regole delle 24 Policy Specializzate (`app/Policies/*`)

Oltre ai metodi standard di [`SnipePermissionsPolicy`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Policies/SnipePermissionsPolicy.php) (`index`, `view`, `create`, `clone`, `update`, `delete`, `files`, `manageFiles`, `history`), ecco le regole specifiche estratte dalle 24 classi in `app/Policies/`:

1. **`CheckoutablePermissionsPolicy`** (base di `AssetPolicy`, `AccessoryPolicy`, `ConsumablePolicy`, `LicensePolicy`):
   - `checkout(user, item?)`: `user.hasAccess('<entity>.checkout')`
   - `checkin(user, item?)`: `user.hasAccess('<entity>.checkin')`
   - `manage(user, item?)`: `checkin || edit || checkout`
2. **`AssetPolicy`**:
   - `audit(user, item?)`: `user.hasAccess('assets.audit')`
   - `viewEncryptedCustomFields(user)`: `user.hasAccess('assets.view.encrypted_custom_fields')`
   - `viewRequestable(user)`: `user.hasAccess('assets.view.requestable')`
3. **`LicensePolicy`**:
   - `viewKeys(user, license?)`: `user.hasAccess('licenses.keys')` (usato nei transformer per mostrare o mascherare `serial`).
4. **`MaintenancePolicy` & `MaintenanceTypePolicy`**:
   - Delega ai permessi `assets.edit` / `assets.view` (poiché le manutenzioni sono figlie degli Asset).
5. **`PredefinedKitPolicy`**:
   - Usa `kits.view`, `kits.create`, `kits.edit`, `kits.delete`, più `kits.edit` o `assets.checkout` per il checkout del kit.
6. **`SavedSearchPolicy`**:
   - Ogni utente può vedere, modificare ed eliminare **solo** le proprie `SavedSearch` (`savedSearch.createdBy === user.id`).

---

## 4. Full Multiple Company Support (FMCS) — Specifica Completa

Dall'analisi di [`app/Models/Company.php`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Models/Company.php#L258-L800), l'isolamento multi-company di Snipe-IT ha regole molto precise (inclusi i fix di sicurezza `GHSA-8hq6-r8cw-gqwh` e `#19187`):

### 4.1 Variabili di Configurazione Globali (`settings`)
- `full_multiple_companies_support` (`boolean`): Se `false`, nessun filtro aziendale viene applicato.
- `null_company_is_floater` (`boolean`): Determina se gli elementi con `company_id = NULL` (e gli utenti senza aziende nella tabella pivot `company_user`) sono visibili e assegnabili trasversalmente ("floater") oppure strettamente isolati.
- `scope_locations_fmcs` (`boolean`): Se `false`, la tabella `locations` è condivisa tra tutte le aziende anche con FMCS attivo; se `true`, anche le `locations` vengono filtrate per `company_id`.

### 4.2 Calcolo di `userCompanyIds` (Con Espansione Gerarchica a 1 Livello)
In [`Company::getCurrentUserCompanyIds()`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Models/Company.php#L269-L296):
1. L'appartenenza di un utente alle aziende è determinata dalla tabella pivot **`company_user`** (`user_id`, `company_id`).
2. **Gerarchia Parent → Child:** Le aziende supportano 1 livello di gerarchia (`companies.parent_id`). Se un utente è membro di un'azienda madre, **eredita automaticamente l'accesso a tutte le aziende figlie** (`WHERE parent_id IN (directIds)`).
3. Il set risultante `userCompanyIds = unique([...directIds, ...childIds])` viene memorizzato nel contesto della richiesta HTTP (`RequestContext`).

### 4.3 Regole di Visibilità e Scrittura con FMCS Attivo (Per Utenti Non-Superuser)

| Caso Utente (`userCompanyIds`) | Modalità `null_company_is_floater = false` (Strict) | Modalità `null_company_is_floater = true` (Floater) |
| :--- | :--- | :--- |
| **Utente con aziende (`userCompanyIds = [1, 2]`)** | Vede e modifica solo righe con `company_id IN (1, 2)`. Utenti visibili: solo quelli presenti in `company_user` per `(1, 2)`. | Vede e modifica righe con `company_id IN (1, 2) OR company_id IS NULL`. Utenti visibili: membri di `(1, 2)` oppure utenti senza alcuna riga in `company_user`. |
| **Utente senza aziende (`userCompanyIds = []`)** | Vede e modifica **solo** righe con `company_id IS NULL` (e solo utenti senza righe in `company_user`). Non vede alcuna Company. | Nessuna restrizione sulle entità/utenti (`floater`), ma non vede alcuna Company nella lista `companies`. |
| **Assegnazione `company_id` in Creazione/Modifica** | Se invia un `company_id` non presente in `userCompanyIds`, la richiesta viene **rifiutata con 422 Validation Error** (mai sovrascritta silenziosamente). Se non invia `company_id` e `userCompanyIds.length === 1`, viene impostato `userCompanyIds[0]`. | Come a sinistra, ma `company_id = null` è permesso. |
| **Verifica `canCheckoutTo(item, target)`** | Un elemento (`Asset`, `License`, `Accessory`, `Consumable`, `Component`) può fare checkout verso un `User`, `Asset` o `Location` **solo** se la company dell'elemento è compatibile con le company del target. | Un elemento o target con `company_id = null` è compatibile con qualsiasi company. |
