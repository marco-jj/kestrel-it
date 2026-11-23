# 07 — Frontend Angular Architecture & Legacy UI Mapping

Questo documento mappa i principali flussi del layer di presentazione di Snipe-IT — composto dalle viste Blade in [`../snipe-it/resources/views/`](https://github.com/grokability/snipe-it/tree/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/resources/views), dai **18 componenti Livewire** in [`../snipe-it/app/Livewire/`](https://github.com/grokability/snipe-it/tree/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Livewire) e dal monolite JavaScript [`../snipe-it/resources/assets/js/snipeit.js`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/resources/assets/js/snipeit.js) (analizzato staticamente con REA, Evidence ID `ev_120d59f71811392c05389de53fd2a62bd534eb469cab9c496078f5cd2233aeed`) — nell'architettura **Angular (Standalone Components + Signals)** di Kestrel-IT (`apps/web`).

---

## 1. Cosa Sostituiamo del Frontend Legacy (Evidenze REA su `snipeit.js` + Livewire)

Dall'analisi REA del codice JavaScript in `../snipe-it/resources/assets/js` (11 file, 28.654 nodi AST) e dall'analisi di `app/Livewire/`, il frontend di Snipe-IT si appoggia a 5 meccanismi legacy che in Kestrel-IT diventano componenti Angular nativi e riutilizzabili:

| Meccanismo Legacy in Snipe-IT | Funzione nel Codice Originale | Componente Angular in Kestrel-IT (`apps/web/src/app/shared/*`) |
| :--- | :--- | :--- |
| **Bootstrap-Table Server-Side + Custom Formatters** (`snipeit.js`) | Tabelle paginabili con colonne dinamiche, export, bulk actions toolbar, persistenza colonne in `localStorage`, e decine di formatter JS (`polymorphicItemFormatter`, `assetActionsFormatter`, `statusMetaFormatter`). | **`<kestrel-data-grid>`**: Componente DataGrid server-side basato su Signals (`page`, `pageSize`, `sort`, `order`, `search`, `advancedFilters`, `selectedIds`), salvataggio preset su `/api/v1/saved-searches` e rendering delle azioni guidato direttamente dall'oggetto `row.available_actions`. |
| **Select2 AJAX (`class="js-data-ajax"`)** (`snipeit.js` + `ModalController`) | Dropdown asincroni che interrogano `/api/v1/<endpoint>/selectlist`, propagano `data-company-id` (`companyId`) per FMCS e `data-asset-status-type` (`statusType`), e permettono la creazione "al volo" tramite modale (`ModalController::show`). | **`<kestrel-async-select>`**: `ControlValueAccessor` Angular con Signals + `rxResource` / debounce, che accetta `endpoint`, `companyId()` (Signal reattivo collegato al campo Company del form!), `statusType()`, `includeNull` e pulsante `+ New` che apre il dialog di creazione rapida. |
| **Modali jQuery Imperativi** (`#adjustQuantityModal`, `#requestItemModal`, `#completeMaintenanceModal`, `#dataConfirmModal`, `#restoreConfirmModal`) | Manipolazione diretta del DOM in `snipeit.js` (righe 149–393): leggi `data-*` dal bottone cliccato, mostra/nascondi i campi acquisto se `amount > 0`, pre-popola `lastUnitCost`/`lastCurrency`, svuota gli input tra un'apertura e l'altra. | **Dialog tipizzati Angular** (`AdjustQuantityDialogComponent`, `RequestItemDialogComponent`, `CompleteMaintenanceDialogComponent`, `ConfirmActionDialogComponent`) con `ReactiveForms` e stato isolato per ogni apertura (nessun rischio di state-bleeding tra aperture). |
| **18 Widget Livewire v4** (`app/Livewire/*`) | Componenti server-driven sparsi dentro pagine Blade (`CustomFieldEditor`, `CheckoutTargetPanel`, `Importer`, `Labels`, `IntegrationSettingsForm`, `AlertMenu`, `NeedsAttention`, `ReportTemplateSelect`, ecc.). | **Componenti Angular Standalone con Signals**, eliminando il doppio paradigma Blade + Livewire + jQuery. |
| **SignaturePad & Chart.js v2.9.4** (`signature_pad.js`, `Chart.min.js`) | Canvas HTML5 per firma accettazione EULA e grafici dashboard v2 (`horizontalBar`, `doughnut`). | **`<kestrel-signature-pad>`** (Canvas touch/mouse nativo) e componenti Chart basati su Chart.js v4. |

---

## 2. Mappatura 1:1 dei 18 Componenti Livewire → Componenti Angular

| Componente Livewire in `../snipe-it/app/Livewire/` | Responsabilità Funzionale | Equivalente Angular in `apps/web/src/app/` |
| :--- | :--- | :--- |
| `CheckoutTargetPanel.php` | Selettore a 3 tab (`User` \| `Asset` \| `Location`) nei form di Checkout, che aggiorna il `selectlist` target filtrato per `companyId`. | `shared/components/checkout-target-panel/` |
| `CustomFieldEditor.php` | Form di creazione/modifica `CustomField`: disabilita in tempo reale gli `element` incompatibili col `format` scelto (es. `DATE` → solo `date_picker`), blocca `field_encrypted` su `DATE`/`checkbox`/`radio`, richiede `field_values` su `listbox`/`checkbox`/`radio` e mostra la live preview del campo. | `features/custom-fields/custom-field-editor/` (usa la matrice condivisa in `@kestrel-it/shared`). |
| `CustomFieldSetDefaultValuesForModel.php` | Nel form di un `AssetModel`, quando si seleziona un `CustomFieldset`, carica i campi di quel fieldset per permettere di impostare i valori di default (`custom_field_defaults`). | `features/models/model-fieldset-defaults/` |
| `FieldsetFieldPicker.php` & `CloneFieldset.php` | Aggiunta, riordino drag-and-drop, flag `required` e clonazione di un `CustomFieldset`. | `features/custom-fields/fieldset-detail/` |
| `AssetAdditionalTags.php` | Nel form di creazione Asset, permette di aggiungere `N` blocchi `(asset_tag, serial)` per creare più esemplari dello stesso modello in un solo salvataggio. | `features/hardware/asset-multi-tag-input/` |
| `CategoryEditForm.php` | Form categoria con toggle dinamico EULA custom vs `use_default_eula` e preview. | `features/taxonomy/categories/category-form/` |
| `Importer.php` | Upload file CSV, selezione `import_type`, auto-matching colonne (`header_row` → `field_map`), preview `first_row`, barra di progresso ed elenco errori riga per riga. | `features/importer/importer-wizard/` |
| `Labels/*` | Editor visuale dei layout etichette (`CustomUserLabel`), anteprima live PDF/SVG delle dimensioni, margini, QR/Barcode e campi selezionati. | `features/labels/label-designer/` |
| `AlertMenu.php` & `NeedsAttention.php` | Campanella notifiche in topbar e widget dashboard per scorte basse (`/api/v1/low-stock`), audit in scadenza, checkin scaduti e accettazioni pendenti. | `core/layout/alert-menu/` & `features/dashboard/needs-attention-widget/` |
| `ReportTemplateSelect.php` | Nel Custom Asset Report, carica/salva/aggiorna i `ReportTemplate` (selezione checkbox delle colonne standard e custom fields da esportare). | `features/reports/custom-asset-report/` |
| `IntegrationSettingsForm.php` | Configurazione webhook (Slack, MS Teams, Google Chat, Generic) con pulsante "Test Webhook". | `features/settings/integrations-settings/` |
| `PersonalAccessTokens.php`, `AdminPersonalAccessTokens.php`, `OauthClients.php` | Creazione token API (con visualizzazione one-time del token generato) e revoca. | `features/account/api-tokens/` & `features/settings/api-tokens/` |
| `LocationScopeCheck.php` | Diagnostica delle incongruenze di `company_id` sulle Location quando si attiva `scope_locations_fmcs`. | `features/settings/location-scope-diagnostic/` |

---

## 3. Mappa delle rotte Angular (`apps/web/src/app/app.routes.ts`)

### Rotte di inventario disponibili dalla Fase 2

| Percorso | Funzioni disponibili |
| :--- | :--- |
| `/hardware` | Lista, filtri, ricerche salvate e quickscan. Creazione, dettaglio, modifica, checkout e check-in si aprono in drawer. Il bulk edit mostra i custom field comuni agli asset selezionati oppure quelli del modello di destinazione. |
| `/models` | Lista, dettaglio, creazione, modifica, clonazione, eliminazione e ripristino tramite drawer. |
| `/fields`, `/fieldsets` | Catalogo, composizione dei fieldset, obbligatorietà e riordino. |
| `/companies`, `/groups`, `/users`, `/locations`, `/departments`, `/categories`, `/manufacturers`, `/suppliers`, `/statuslabels` | Directory, con azioni bulk offerte secondo il permesso dell'operatore. Per le risorse con soft-delete, il ripristino bulk è disponibile nella vista dei record eliminati. |
| `/account/accept`, `/account/accept/:id`, `/account/eulas` | Accettazioni, firma su canvas quando richiesta e download di EULA e firma. |
| `/account/requestable`, `/account/requests`, `/requests` | Catalogo hardware e modelli, richieste personali e coda per operatori con `assets.checkout`. `/account/requestable-assets` reindirizza al catalogo. |

### Struttura prevista per la parità

L’albero propone la struttura Angular a partire dalle rotte UI di [`../snipe-it/routes/web.php`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web.php) e [`../snipe-it/routes/web/*`](https://github.com/grokability/snipe-it/tree/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web) con breadcrumb e guard per le rotte protette. Il guard di setup reindirizza a `/setup` finché la configurazione iniziale è incompleta.

```text
/setup                                  # SetupWizardComponent a 3 step (protetto da setupIncompleteGuard):
                                        #   1) Pre-Flight Check, 2) Instance & Asset Tag Settings, 3) First Superuser Account
/login                                  # Local Login + pulsante "Sign in with SSO (OIDC)"
/login/2fa                              # Verifica TOTP 2FA o enrollment iniziale
/auth/oidc/callback                     # Callback OIDC PKCE
/forgot-password, /reset-password       # Recupero password account locali

/                                       # Layout Shell autenticato (Sidebar, Topbar, AlertMenu, Breadcrumbs)
├── /dashboard                          # KPI Cards, Activity Feed, Chart per Status/Category/Company, NeedsAttention
├── /calendar                           # Calendario unificato (Audit, Expected Checkin, Garanzie, Licenze, Manutenzioni)
│
├── /hardware                           # Lista Asset (tutti o filtrati per status: Deployable, Deployed, Pending, Archived, BYOD, Deleted)
│   ├── /create                         # Creazione Asset (con AssetAdditionalTags e CustomFields dinamici per modello)
│   ├── /bulk-checkout                  # Checkout multiplo di N asset verso User / Location / Asset
│   ├── /bulk-edit                      # Modifica massiva (status, location, company, acquisto, custom fields)
│   ├── /audit/due, /audit/overdue      # Liste e form di Audit fisico singolo o bulk
│   ├── /:id                            # Dettaglio Asset a 9 Tab:
│   │                                   #   (Info, Licenses, Components, Accessories, Maintenances, History, Files, Notes, Calendar)
│   ├── /:id/edit                       # Modifica Asset (o Clone)
│   ├── /:id/checkout                   # Checkout Asset (con CheckoutTargetPanel + CustomFields display_checkout + Sign-in-place)
│   ├── /:id/checkin                    # Checkin Asset (con status override, location override e CustomFields display_checkin)
│   └── /:id/audit                      # Form Audit Asset (con upload foto, location, next_audit_date e CustomFields display_audit)
│
├── /models                             # Lista, Creazione, Dettaglio (con tab Assets & Files), Modifica, Bulk Edit/Delete Asset Models
├── /fields                             # Gestione Custom Fields (con CustomFieldEditor) e Custom Fieldsets (/fieldsets/:id)
│
├── /licenses                           # Lista, Creazione, Dettaglio (con tab Seats, Files, History), Checkout/Checkin Seat
├── /accessories                        # Lista, Creazione, Dettaglio (tab Checked-Out & History), Checkout, Checkin, Adjust Quantity
├── /consumables                        # Lista, Creazione, Dettaglio, Checkout (consume), Adjust Quantity
├── /components                         # Lista, Creazione, Dettaglio (tab Assigned Assets), Checkout a Asset, Checkin parziale, Adjust Quantity
├── /kits                               # Predefined Kits: Lista, Composizione (Models, Licenses, Consumables, Accessories), Kit Checkout
├── /maintenances                       # Asset Maintenances & Maintenance Types (/maintenance-types)
│
├── /users                              # Lista, Creazione, Dettaglio (tab Assets, Licenses, Accessories, Consumables, EULAs, History, Files, Managed Locations/Users), Bulk actions
├── /groups                             # Gestione Gruppi e Matrice Permessi (`Grant` / `Deny`)
├── /companies                          # Gestione Aziende (gerarchia Parent/Child, tab elementi per azienda, webhook aziendale)
├── /locations                          # Gestione Sedi (albero gerarchico, asset assegnati alla sede, asset con RTD nella sede, stampa audit)
├── /departments                        # Gestione Dipartimenti
├── /categories                         # Gestione Categorie (EULA, flag require_acceptance, checkin_email)
├── /manufacturers                      # Gestione Produttori (con seed produttori standard IT)
├── /suppliers                          # Gestione Fornitori
├── /statuslabels                       # Gestione Status Labels (Deployable, Pending, Archived, Undeployable, colori grafico)
├── /depreciations                      # Gestione Piani di Ammortamento (Linear, Half-Year, Diminishing)
│
├── /import                             # Wizard CSV Importer (12 tipi)
├── /reports                            # 8+ Report:
│   ├── /activity                       # Activity Log globale filtrabile
│   ├── /custom                         # Custom Asset Report Builder (con salvataggio ReportTemplates)
│   ├── /depreciation                   # Report Ammortamenti e Valore Contabile (Book Value)
│   ├── /licenses                       # Report Licenze e utilizzo postazioni
│   ├── /maintenances                   # Report Manutenzioni e costi
│   ├── /unaccepted-assets              # Asset / Accessori in attesa di accettazione EULA (con invio solleciti bulk)
│   ├── /accessories                    # Report Accessori
│   └── /audit                          # Report Storico Audit fisici
│
├── /account                            # Self-Service Portal per ogni utente autenticato:
│   ├── /profile                        # Modifica profilo, lingua, password, avatar, 2FA TOTP
│   ├── /view-assets                    # "My Assigned Assets, Licenses, Accessories & Consumables" + scarico EULA firmati
│   ├── /accept                         # Coda accettazioni pendenti (`/account/accept/:id` con lettura EULA + SignaturePad)
│   ├── /requestable                    # Catalogo Self-Service (Hardware, Models, Accessories, Consumables, Components, Licenses)
│   └── /api                            # Gestione Personal Access Tokens (se ha permesso `self.api`)
│
└── /admin                              # Impostazioni Globali (solo `superuser`):
    ├── /settings                       # General Settings, Asset Tags, Barcodes, Security, Localization, Notifications
    ├── /branding                       # Logo, Favicon, Colori, Custom CSS, Footer
    ├── /labels                         # Label Designer visuale e template di stampa PDF
    ├── /integrations                   # Configurazione OIDC, SMTP (con test mail), Webhooks (Slack/Teams/Generic)
    └── /login-attempts                 # Registro accessi e audit di sicurezza
```

---

### Mappatura dei flussi amministrativi

| Funzionalità Snipe-IT | Comportamento osservato | Kestrel-IT |
| :--- | :--- | :--- |
| Backup e ripristino | Elenco, creazione, caricamento, download, eliminazione e ripristino dei backup. [Rotte web](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web.php#L500-L529) | Definire la copertura nell'interfaccia, nell'API o negli strumenti operativi. |
| Sincronizzazione LDAP | Configurazione LDAP e avvio manuale del sync utenti dalla gestione utenti. [Configurazione](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web.php#L429-L443), [Sync utenti](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web/users.php#L9-L27) | Provisioning JIT al login e provisioning push di utenti e gruppi via SCIM 2.0 nel Piano 4.2. La directory resta gestita dall'IdP. [Piano 4.2](../PLAN.md) |

## 4. Architettura Reattiva in Angular (Signals + RBAC + FMCS)

1. **`AuthStore` (Angular Signal Store in `core/auth/auth.store.ts`)**:
   - Mantiene `currentUser = signal<UserProfile | null>(null)`, `permissions = computed(...)`, `settings = signal<PublicSettings>(...)`.
   - Espone il metodo `can(permission: PermissionKey): boolean` che usa la stessa funzione pura `@kestrel-it/shared` del backend, più una direttiva strutturale `*kestrelCan="'assets.checkout'"`.
2. **Reattività Company-Scoped (FMCS nei Form)**:
   - Nei form di creazione/modifica o checkout, il campo `companyId` è esposto come `Signal<number | null>` (tramite `toSignal(form.controls.companyId.valueChanges)`).
   - Tutti i `<kestrel-async-select>` figli nella stessa schermata (es. Location, Department, User target, Asset target) ricevono `[companyId]="selectedCompanyId()"` e ricaricano automaticamente i risultati filtrati per quell'azienda quando l'operatore cambia azienda.
