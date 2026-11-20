# 04 — Domain Workflows, State Machines & Business Calculations

Questo documento descrive la logica transazionale e le formule matematiche estratte dai Services e Models di Snipe-IT (`AssetCheckoutService`, `PredefinedKitCheckoutService`, `Depreciable`, `CheckoutAcceptance`, `CheckoutRequest`, `AdjustsQuantity`).

---

## 1. Macchina a Stati degli Asset e Checkout Polimorfico

### 1.1 Meta-Stati di un Asset (`Statuslabel` + Assegnazione)
Un Asset ha uno `status_id` che punta a `status_labels` (`deployable`, `pending`, `archived`) e un'assegnazione polimorfica `(assigned_to, assigned_type)`:

| `status_label` Flags | `assigned_to` | Meta-Stato Calcolato (`status_meta`) | Può fare Checkout (`availableForCheckout`)? | Può essere Eliminato? |
| :--- | :--- | :--- | :--- | :--- |
| `deployable = 1, pending = 0, archived = 0` | `NULL` | **`deployable`** (Ready to Deploy / RTD) | **Sì** (se `deleted_at IS NULL`) | **Sì** |
| `deployable = 1, pending = 0, archived = 0` | `NOT NULL` | **`deployed`** (Assigned) | **No** (deve prima fare Checkin) | **No** (deve prima fare Checkin) |
| `pending = 1` | `NULL` / `NOT NULL` | **`pending`** | **No** | Sì (se `assigned_to IS NULL`) |
| `archived = 1` | `NULL` / `NOT NULL` | **`archived`** | **No** | Sì (se `assigned_to IS NULL`) |
| `deployable = 0, pending = 0, archived = 0` | `NULL` / `NOT NULL` | **`undeployable`** | **No** | Sì (se `assigned_to IS NULL`) |

```mermaid
stateDiagram-v2
    [*] --> RTD: Creazione Asset (Status Deployable)
    RTD --> Deployed: Checkout (a User / Location / Asset)
    Deployed --> RTD: Checkin (ripristina location a rtd_location_id o override)
    RTD --> Pending: Cambio StatusLabel (Pending)
    Pending --> RTD: Cambio StatusLabel (Deployable)
    RTD --> Undeployable: Cambio StatusLabel (Undeployable / In Riparazione)
    Undeployable --> RTD: Cambio StatusLabel (Deployable)
    RTD --> Archived: Cambio StatusLabel (Archived)
    RTD --> SoftDeleted: Delete (solo se assigned_to IS NULL)
    SoftDeleted --> RTD: Restore
```

---

### 1.2 Flusso Transazionale di Checkout Asset ([`AssetCheckoutService.php`](file:///Users/thor/development/snipe-it/app/Services/AssetCheckoutService.php))

Quando viene invocato `POST /api/v1/hardware/{id}/checkout` (o `/bytag/{tag}/checkout` o Bulk Checkout):

1. **Lock & Pre-condizioni (Transazione Drizzle `FOR UPDATE`):**
   - L'asset deve esistere, avere `deleted_at IS NULL` ed essere `availableForCheckout() === true`.
   - **Guardia Auto-Assegnazione:** Un asset non può fare checkout a se stesso (`targetType === 'asset' && target.id === asset.id`).
   - **Guardia FMCS (`canCheckoutTo`):** Se FMCS è attivo, `asset.companyId` deve essere compatibile con il target (`User`, `Location` o `Asset`).
2. **Risoluzione della Posizione (`location_id` vs `rtd_location_id`):**
   - `rtd_location_id` (Ready-To-Deploy / Home Location) **non viene modificato** durante il checkout.
   - `asset.locationId` viene aggiornato in base al tipo di target:
     - Se `target` è una **`Location`** → `asset.locationId = target.id`
     - Se `target` è un **`Asset`** → `asset.locationId = target.locationId ?? target.rtdLocationId`
     - Se `target` è un **`User`** → `asset.locationId = target.locationId` (può essere `null`)
3. **Propagazione dei License Seats collegati all'Asset (`propagateLicenseSeats` - Fix `GHSA-9wq4-gp32-rcgj`):**
   - Se `target` è un `User` e l'asset ha dei `license_seats` associati (`license_seats.asset_id = asset.id`):
     - **Validazione preventiva su ogni seat:**
       - Se `seat.unreassignableSeat === true` → lancia `CheckoutNotAllowedException`.
       - Se `seat.assignedTo !== null && seat.assignedTo !== target.id && !seat.license.reassignable` → lancia `CheckoutNotAllowedException`.
     - **Aggiornamento seats:**
       - Per ogni seat che aveva un precedente `assignedTo !== target.id`: elimina eventuali `CheckoutAcceptance` pendenti del vecchio utente per quel seat, emette un evento `CheckoutableCheckedIn` (che scrive l'`Actionlog` di checkin dal vecchio utente), e assegna `seat.assignedTo = target.id`.
4. **Aggiornamento Campi Asset & Contatori:**
   - `asset.assignedTo = target.id`
   - `asset.assignedType = targetType` (`'user' | 'location' | 'asset'`)
   - `asset.lastCheckout = checkoutAt ?? now()`
   - `asset.expectedCheckin = expectedCheckin ?? null`
   - `asset.name = overrideName ?? asset.name`
   - `asset.checkoutCounter = asset.checkoutCounter + 1`
   - Aggiornamento di eventuali `custom_fields` con `display_checkout = true` inviati nel form.
5. **Creazione `Actionlog` e `CheckoutAcceptance` (se `target` è `User`):**
   - Scrive una riga in `action_logs` con `action_type = 'checkout'`, `item_type = 'asset'`, `item_id = asset.id`, `target_type = targetType`, `target_id = target.id`, `location_id = asset.locationId`, `note`, `expected_checkin`.
   - Se `target` è `User` e `asset.model.category.requireAcceptance === true`:
     - Crea un record in `checkout_acceptances` (`pending`), salvando uno snapshot del testo EULA attivo (`stored_eula`).
     - Se `signInPlace === true` (firma immediata allo sportello), allega subito `signature_filename` e marca `accepted_at = now()`.
   - Invia le notifiche `CheckoutAssetNotification` (Email / Webhook).

---

### 1.3 Flusso Transazionale di Checkin Asset (`AssetCheckinController` / `Api\AssetsController::checkin`)

Quando viene invocato `POST /api/v1/hardware/{id}/checkin`:
1. **Lock & Pre-condizioni:** L'asset deve essere attualmente assegnato (`assigned_to IS NOT NULL`).
2. **Pulizia Acceptance Pendenti:** Se esiste una `CheckoutAcceptance` con `accepted_at IS NULL AND declined_at IS NULL` per questo asset, viene eliminata (soft-delete).
3. **Ripristino Posizione (`location_id`):**
   - `asset.locationId = request.locationId ?? asset.rtdLocationId`
   - Se il form specifica `updateDefaultLocation = true`, aggiorna anche `asset.rtdLocationId = request.locationId`.
4. **Reset Assegnazione e Contatori:**
   - Salva `previousTarget = (asset.assignedType, asset.assignedTo)`.
   - `asset.assignedTo = null`, `asset.assignedType = null`, `asset.expectedCheckin = null`, `asset.accepted = null`.
   - `asset.lastCheckin = checkinAt ?? now()`.
   - `asset.checkinCounter = asset.checkinCounter + 1`.
   - Opzionalmente aggiorna `asset.statusId` (es. se l'asset rientra guasto → status `"Pending Repair"`) e `asset.name`.
   - Aggiorna eventuali `custom_fields` con `display_checkin = true`.
5. **Actionlog & Notifiche:**
   - Scrive in `action_logs` con `action_type = 'checkin from'`, `target_type = previousTarget.type`, `target_id = previousTarget.id`.
   - Se `category.checkinEmail === true`, invia `CheckinAssetNotification`.

---

## 2. EULA & Flusso di Accettazione / Rifiuto (`CheckoutAcceptance`)

1. **Risoluzione del testo EULA:**
   - Se `category.useDefaultEula === true`, usa `settings.defaultEulaText`.
   - Altrimenti usa `category.eulaText`.
2. **Stati di `CheckoutAcceptance`:**
   - **Pending:** `accepted_at IS NULL AND declined_at IS NULL`
   - **Accepted:** `accepted_at IS NOT NULL`
   - **Declined:** `declined_at IS NOT NULL`
3. **Azione dell'Utente (`/account/accept/{id}`):**
   - L'utente assegnatario (`assigned_to_id === currentUser.id`) visualizza l'EULA.
   - Se `settings.requireAcceptSignature === true`, deve firmare sul canvas (`SignaturePad`), che invia il data-URL PNG salvato nello storage (`signatures/sig-<id>-<timestamp>.png`).
   - **Se Accetta (`accept`):**
     - `accepted_at = now()`, `signature_filename = ...`
     - Genera un PDF immutabile (`stored_eula_file`) contenente l'EULA, i dati dell'asset, l'utente, la data e l'immagine della firma.
     - Scrive `action_logs` (`action_type = 'accepted'`).
     - Se `category.alertOnResponse === true`, invia `AcceptanceItemAcceptedNotification` all'admin che aveva effettuato il checkout (`alert_on_response_id`) e `AcceptanceItemAcceptedToUserNotification` all'utente.
   - **Se Rifiuta (`decline`):**
     - `declined_at = now()`
     - Scrive `action_logs` (`action_type = 'declined'`).
     - Invia `AcceptanceItemDeclinedNotification` all'admin (`alert_on_response_id`).

---

## 3. Checkout di Predefined Kits ([`PredefinedKitCheckoutService.php`](file:///Users/thor/development/snipe-it/app/Services/PredefinedKitCheckoutService.php))

Un `PredefinedKit` raggruppata quantità predefinite di:
- **Asset Models** (`kits_models`: seleziona automaticamente `N` asset RTD disponibili di quel modello compatibili per FMCS con l'utente target)
- **Licenses** (`kits_licenses`: seleziona `N` `freeSeats` disponibili compatibili per FMCS)
- **Consumables** (`kits_consumables`: verifica che `numRemaining() >= quantity` e che sia compatibile per FMCS)
- **Accessories** (`kits_accessories`: verifica che `numRemaining() >= quantity` e che sia compatibile per FMCS)

**Regola di Concorrenza (Transazione con `SELECT ... FOR UPDATE`):**
1. Fase di pre-validazione: raccoglie tutti i candidati e accumula tutti gli errori (stock insufficiente o mismatch FMCS `error_checkout_company_mismatch`). Se c'è anche un solo errore, interrompe prima di modificare il DB.
2. Fase di commit in transazione Drizzle:
   - Ri-acquisisce ogni `Asset`, `LicenseSeat`, `Consumable` e `Accessory` con **lock pessimistico `FOR UPDATE`** per prevenire race condition tra due operatori che fanno checkout dello stesso kit contemporaneamente.
   - Esegue i checkout, scrive i rispettivi `action_logs` e crea eventuali `CheckoutAcceptance`.

---

## 4. Motore Matematico di Ammortamento ([`Depreciable.php`](file:///Users/thor/development/snipe-it/app/Models/Depreciable.php))

Applicabile sia agli **Asset** (tramite `asset.model.depreciation`) sia alle **Licenze** (tramite `license.depreciation`).
Richiede `purchaseCost > 0`, `purchaseDate != null` e `depreciation.months > 0`.

### 4.1 Calcolo del Valore Minimo Residuo (`floorValue`)
Dalla funzione `calculateDepreciation()` in [`Depreciable.php`](file:///Users/thor/development/snipe-it/app/Models/Depreciable.php#L294-L306):
- Se `depreciation.depreciationType === 'percent'`:
  $$\text{floorValue} = \text{purchaseCost} \times \left(\frac{\text{depreciationMin}}{100}\right)$$
- Se `depreciation.depreciationType === 'amount'` (default):
  $$\text{floorValue} = \text{depreciationMin} \ ?? \ 0$$

### 4.2 I 4 Metodi di Ammortamento (`settings.depreciation_method`)

1. **`default` (Ammortamento Lineare Mensile — `getLinearDepreciatedValue`)**:
   - $\text{monthsPassed} = (\text{now.year} - \text{purchaseDate.year}) \times 12 + (\text{now.month} - \text{purchaseDate.month})$
   - Se $\text{monthsPassed} \ge \text{depreciation.months}$:
     $$\text{currentValue} = \text{floorValue}$$
   - Altrimenti:
     $$\text{currentValue} = \text{round}\left(\text{purchaseCost} - (\text{purchaseCost} - \text{floorValue}) \times \frac{\text{monthsPassed}}{\text{depreciation.months}},\ 2\right)$$
   - Quota mensile (`getMonthlyDepreciation`):
     $$\text{monthlyDepreciation} = \frac{\text{purchaseCost} - \text{floorValue}}{\text{depreciation.months}}$$

2. **`half_1` (Half-Year Convention — Sempre metà primo anno — `getHalfYearDepreciatedValue(true)`)**:
   - Basato sugli anni fiscali trascorsi (`yearsPast`) rispetto a `depreciationYears = ceil(months / 12)`.
   - Sottrae $0.5$ anni al primo anno e aggiunge $0.5$ se la data corrente è nella seconda metà dell'anno ($\ge \text{1 Giugno}$ e $< \text{31 Dicembre}$).
   - $\text{currentValue} = \text{purchaseCost} - \text{round}\left(\frac{\text{clamp}(\text{yearsPast}, 0, \text{depreciationYears})}{\text{depreciationYears}} \times \text{purchaseCost},\ 2\right)$.

3. **`half_2` (Half-Year Convention — Metà anno applicata solo se acquistato nella seconda metà dell'anno — `getHalfYearDepreciatedValue(false)`)**:
   - Identico a `half_1`, ma sottrae $0.5$ solo se `purchaseDate` cade nella seconda metà dell'anno.

4. **`diminish` (Diminishing Balance / Saldo Decrescente per Anno Fiscale — `getDiminishingDepreciationValue`)**:
   - $\text{effectiveLife} = \frac{\text{depreciation.months}}{12}$
   - $\text{rateMultiplier} = \text{depreciation.rateMultiplier} \ ?? \ 2.0$
   - $\text{diminishingRate} = \frac{\text{rateMultiplier}}{\text{effectiveLife}}$
   - Suddivide l'intervallo da `purchaseDate` a `currentDate` in periodi annuali allineati a `depreciation.fiscalYearStartMonth` (default `1` = Gennaio).
   - Per ciascun periodo di $\text{daysHeld}$ giorni (estremi inclusi):
     $$\text{declineInValue} = \text{baseValue} \times \left(\frac{\text{daysHeld}}{365}\right) \times \text{diminishingRate}$$
     $$\text{baseValue} = \text{baseValue} - \min(\text{declineInValue}, \text{baseValue})$$
   - Ritorna $\text{round}(\max(\text{baseValue}, 0), 2)$.

---

## 5. Rifornimento Scorte & Adjust Quantity (`AdjustsQuantity` + `OrderItems`)

Introdotto per **Accessories**, **Consumables** e **Components** (`POST /api/v1/{entity}/{id}/adjust-quantity`):
- Riceve un delta con segno (`amount`, intero $\neq 0$).
- **Vincolo di Floor:** La nuova quantità totale `newQty = item.qty + amount` **non può mai scendere sotto il numero di unità attualmente assegnate/in uso** (`currentlyInUseCount`). Se `amount < -(item.qty - currentlyInUseCount)`, lancia un errore di validazione 422 (`DomainException`).
- **Se `amount > 0` (Acquisto / Rifornimento):**
  - Se vengono forniti metadati d'acquisto (`order_number`, `supplier_id`, `unit_cost`, `currency`, `purchase_date`), crea o aggiorna l'`Order` e inserisce una riga in `order_items` collegata all'`Actionlog`.
- **Se `amount < 0` (Rettifica / Perdita / Scarto):**
  - Ignora i metadati d'acquisto, decrementa `item.qty` e registra l'`Actionlog` con eventuale nota obbligatoria se `settings.requireAdjustQuantityNotes === true`.
