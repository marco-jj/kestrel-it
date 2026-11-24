# 07 — Frontend Angular Architecture & Legacy UI Mapping

Questo documento mappa i principali flussi del layer di presentazione di Snipe-IT — composto dalle viste Blade in [`../snipe-it/resources/views/`](https://github.com/grokability/snipe-it/tree/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/resources/views), dai **18 componenti Livewire** in [`../snipe-it/app/Livewire/`](https://github.com/grokability/snipe-it/tree/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/app/Livewire) e dal monolite JavaScript [`../snipe-it/resources/assets/js/snipeit.js`](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/resources/assets/js/snipeit.js) (analizzato staticamente con REA, Evidence ID `ev_120d59f71811392c05389de53fd2a62bd534eb469cab9c496078f5cd2233aeed`) — nell'architettura **Angular (Standalone Components + Signals)** di Kestrel-IT (`apps/web`).

---

## 1. Cosa Sostituiamo del Frontend Legacy (Evidenze REA su `snipeit.js` + Livewire)

Dall'analisi REA del codice JavaScript in `../snipe-it/resources/assets/js` (11 file, 28.654 nodi AST) e dall'analisi di `app/Livewire/`, il frontend di Snipe-IT si appoggia a 5 meccanismi legacy che in Kestrel-IT diventano componenti Angular nativi e riutilizzabili:

| Meccanismo Legacy in Snipe-IT | Funzione nel Codice Originale | Componente Angular in Kestrel-IT (`apps/web/src/app/`) |
| :--- | :--- | :--- |
| **Bootstrap-Table Server-Side + Custom Formatters** (`snipeit.js`) | Tabelle paginabili con colonne dinamiche, export, bulk actions toolbar, persistenza colonne in `localStorage`, e decine di formatter JS (`polymorphicItemFormatter`, `assetActionsFormatter`, `statusMetaFormatter`). | **`<kestrel-data-grid>`** (`shared/ui/data-grid.component.ts`): DataGrid server-side basato su Signals (`page`, `pageSize`, `sort`, `order`, `search`, `selectedIds`), salvataggio preset su `/api/v1/saved-searches` e rendering delle azioni guidato da `row.available_actions`. |
| **Select2 AJAX (`class="js-data-ajax"`)** (`snipeit.js` + `ModalController`) | Dropdown asincroni che interrogano `/api/v1/<endpoint>/selectlist`, propagano `data-company-id` (`companyId`) per FMCS e `data-asset-status-type` (`statusType`), e permettono la creazione "al volo" tramite modale (`ModalController::show`). | **`<kestrel-async-select>`** (`shared/ui/async-select.component.ts`): `ControlValueAccessor` Angular con Signals che accetta `endpoint`, `companyId()` e `statusType()` per query FMCS reattive. |
| **Modali jQuery Imperativi** (`#adjustQuantityModal`, `#requestItemModal`, `#completeMaintenanceModal`, `#dataConfirmModal`, `#restoreConfirmModal`) | Manipolazione diretta del DOM in `snipeit.js` (righe 149–393): leggi `data-*` dal bottone cliccato, mostra/nascondi i campi acquisto se `amount > 0`, pre-popola `lastUnitCost`/`lastCurrency`, svuota gli input tra un'apertura e l'altra. | **`<kestrel-slide-drawer>`** (`shared/ui/slide-drawer.component.ts`) e form reattivi standalone nelle viste inventario (`asset-lifecycle.component.ts`, `phase-three-page.component.ts`, `checkout-requests-page.component.ts`), con stato isolato ad ogni apertura. |
| **18 Widget Livewire v4** (`app/Livewire/*`) | Componenti server-driven sparsi dentro pagine Blade (`CustomFieldEditor`, `CheckoutTargetPanel`, `Importer`, `Labels`, `IntegrationSettingsForm`, `AlertMenu`, `NeedsAttention`, `ReportTemplateSelect`, ecc.). | **Componenti Angular Standalone con Signals** sotto `core/layout/`, `features/dashboard/` e `features/inventory/`, eliminando il doppio paradigma Blade + Livewire + jQuery. |
| **SignaturePad & Dashboard Stats** (`signature_pad.js`, `Chart.min.js`) | Canvas HTML5 per firma accettazione EULA e grafici/statistiche dashboard. | Canvas firma nativo integrato in `features/inventory/acceptance-page.component.ts` e viste statistiche reattive in `features/dashboard/dashboard.component.ts`. |

---

## 2. Mappatura 1:1 dei 18 Componenti Livewire → Componenti Angular

| Componente Livewire in `../snipe-it/app/Livewire/` | Responsabilità Funzionale | Equivalente Angular in `apps/web/src/app/` |
| :--- | :--- | :--- |
| `CheckoutTargetPanel.php` | Selettore a 3 tab (`User` \| `Asset` \| `Location`) nei form di Checkout, che aggiorna il `selectlist` target filtrato per `companyId`. | `features/inventory/asset-lifecycle.component.ts` |
| `CustomFieldEditor.php` | Form di creazione/modifica `CustomField`: disabilita in tempo reale gli `element` incompatibili col `format` scelto (es. `DATE` → solo `date_picker`), blocca `field_encrypted` su `DATE`/`checkbox`/`radio`, richiede `field_values` su `listbox`/`checkbox`/`radio` e mostra la live preview del campo. | `features/inventory/custom-fields-page.component.ts` (usa la matrice condivisa in `@kestrel-it/shared`). |
| `CustomFieldSetDefaultValuesForModel.php` | Nel form di un `AssetModel`, quando si seleziona un `CustomFieldset`, carica i campi di quel fieldset per permettere di impostare i valori di default (`custom_field_defaults`). | `features/inventory/custom-field-form-section.component.ts` & `features/inventory/directory-page.component.ts` |
| `FieldsetFieldPicker.php` & `CloneFieldset.php` | Aggiunta, riordino drag-and-drop, flag `required` e clonazione di un `CustomFieldset`. | `features/inventory/custom-fields-page.component.ts` |
| `AssetAdditionalTags.php` | Nel form di creazione Asset, permette di aggiungere `N` blocchi `(asset_tag, serial)` per creare più esemplari dello stesso modello in un solo salvataggio. | `features/inventory/hardware-page.component.ts` |
| `CategoryEditForm.php` | Form categoria con toggle dinamico EULA custom vs `use_default_eula` e preview. | `features/inventory/directory-page.component.ts` & `features/inventory/directory-ui.ts` |
| `Importer.php` | Upload file CSV, selezione `import_type`, auto-matching colonne (`header_row` → `field_map`), preview `first_row`, barra di progresso ed elenco errori riga per riga. | `features/inventory/import-page.component.ts` |
| `Labels/*` | Editor visuale dei layout etichette (`CustomUserLabel`), anteprima live PDF/SVG delle dimensioni, margini, QR/Barcode e campi selezionati. | `features/inventory/labels-settings.component.ts` |
| `AlertMenu.php` & `NeedsAttention.php` | Navigazione notifiche/scorte e widget dashboard per scorte basse (`/api/v1/low-stock`), audit in scadenza, checkin scaduti e accettazioni pendenti. | `core/layout/app-shell.component.ts`, `features/dashboard/low-stock.component.ts` & `features/dashboard/dashboard.component.ts` |
| `ReportTemplateSelect.php` | Nel Custom Asset Report, carica/salva/aggiorna i `ReportTemplate` (selezione checkbox delle colonne standard e custom fields da esportare). | `features/inventory/reports-page.component.ts` |
| `IntegrationSettingsForm.php` | Configurazione OIDC, SMTP e webhook (Slack, MS Teams, Google Chat, Generic) con pulsante "Test". | `features/inventory/admin-settings.components.ts` & `features/inventory/notification-settings.component.ts` |
| `PersonalAccessTokens.php`, `AdminPersonalAccessTokens.php`, `OauthClients.php` | Creazione token API (con visualizzazione one-time del token generato) e revoca. | `features/inventory/account-self-service.components.ts` |
| `LocationScopeCheck.php` | Configurazione e diagnostica delle impostazioni di scope aziendale sulle sedi (`scope_locations_fmcs`). | `features/inventory/admin-settings.components.ts` |

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
| `/account/requestable`, `/account/requests`, `/requests` | Catalogo self-service per tutti e 6 i tipi (`hardware`, `models`, `accessories`, `consumables`, `components`, `licenses`), richieste personali e coda per operatori. `/account/requestable-assets` reindirizza al catalogo. |
| `/licenses`, `/accessories`, `/consumables`, `/components`, `/kits`, `/maintenances`, `/maintenance-types`, `/depreciations` | Gestione completa di inventario secondario, predefined kit, manutenzioni e piani di ammortamento (`PhaseThreePageComponent`). |
| `/hardware/audit/:status`, `/calendar`, `/reports`, `/reports/:type`, `/unaccepted-acceptances`, `/import` | Liste audit (`due`, `overdue`, `due-or-overdue`), calendario unificato, 10 report + export CSV/XLSX + template salvabili, solleciti EULA e wizard CSV Importer (12 tipi). |
| `/account/profile`, `/account/view-assets`, `/account/api`, `/admin/settings`, `/admin/branding`, `/admin/integrations`, `/admin/labels`, `/admin/notifications`, `/admin/login-attempts` | Profilo e 2FA, asset assegnati, PAT token e pannello di amministrazione completo (incluso Label Designer PDF/SVG, notifiche/webhook e registro accessi). |

### Struttura delle rotte implementate

L’albero riepiloga la struttura delle rotte registrate in [`app.routes.ts`](../apps/web/src/app/app.routes.ts) con `setupGuard`, `authGuard` e command palette (`Ctrl/Cmd + K`). Il guard di setup reindirizza a `/setup` finché la configurazione iniziale è incompleta.

```text
/setup                                  # SetupWizardComponent a 3 step (setupIncompleteGuard)
/login                                  # LoginComponent: credenziali locali, verifica 2FA TOTP inline e avvio SSO (OIDC)

/                                       # AppShellComponent autenticato (Sidebar, Topbar, CommandPalette)
├── /dashboard                          # KPI, statistiche risorse, activity feed, low stock
├── /calendar                           # Calendario unificato (Audit, Expected Checkin, Garanzie, Licenze, Manutenzioni)
│
├── /hardware                           # Lista Asset, filtri, ricerche salvate, quickscan e drawer (creazione, dettaglio, modifica, checkout, checkin, bulk edit)
│   └── /audit/:status                  # Liste Audit (due, overdue, due-or-overdue) con form di audit
│
├── /models                             # Lista, dettaglio, creazione, modifica, clonazione, eliminazione e ripristino tramite drawer
├── /fields                             # Gestione Custom Fields
├── /fieldsets                          # Gestione Custom Fieldsets (composizione, obbligatorietà e riordino)
│
├── /licenses                           # Gestione Licenze, seat e drawer checkout/checkin
├── /accessories                        # Gestione Accessori, checkout/checkin e quantità
├── /consumables                        # Gestione Consumabili, checkout e quantità
├── /components                         # Gestione Componenti, assegnazioni ad asset e quantità
├── /kits                               # Predefined Kits: composizione (models/licenses/accessories/consumables) e checkout
├── /maintenances                       # Asset Maintenances
├── /maintenance-types                  # Tipi di manutenzione
├── /depreciations                      # Piani di ammortamento
│
├── /users, /groups, /companies         # Directory utenti, gruppi/permessi e aziende
├── /locations, /departments            # Sedi e dipartimenti
├── /categories, /manufacturers         # Categorie e produttori
├── /suppliers, /statuslabels           # Fornitori e status label
│
├── /import                             # Wizard CSV Importer (12 tipi)
├── /reports, /reports/:type            # 10 report + export CSV/XLSX + template salvabili
├── /unaccepted-acceptances             # Coda accettazioni pendenti con invio solleciti
├── /requests                           # Coda richieste self-service per operatori
│
├── /account                            # Self-Service Portal autenticato:
│   ├── /profile                        # Profilo, lingua, password e 2FA TOTP
│   ├── /view-assets                    # Asset, licenze, accessori e consumabili assegnati
│   ├── /accept, /accept/:id, /eulas    # Coda accettazioni EULA con firma canvas
│   ├── /requestable, /requests         # Catalogo requestable (6 tipi) e richieste personali (`/account/requestable-assets` -> redirect)
│   └── /api                            # Personal Access Tokens (`self.api`)
│
└── /admin                              # Impostazioni Globali (`superuser`):
    ├── /settings                       # General Settings, Asset Tags, Security, Localization, FMCS
    ├── /branding                       # Colori, Custom CSS, Footer, Privacy Policy, Dashboard/Login notes
    ├── /labels                         # Label Designer visuale e template di stampa PDF/SVG
    ├── /notifications                  # Configurazione alert, SMTP (con test) e webhook
    ├── /integrations                   # Configurazione SSO / OIDC
    └── /login-attempts                 # Registro accessi e audit di sicurezza
```

---

### Mappatura dei flussi amministrativi

| Funzionalità Snipe-IT | Comportamento osservato | Kestrel-IT |
| :--- | :--- | :--- |
| Backup e ripristino | Elenco, creazione, caricamento, download, eliminazione e ripristino dei backup. [Rotte web](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web.php#L500-L529) | Responsabilità operativa esterna: backup e ripristino sono gestiti fuori dalla SPA e dall'API tramite snapshot PostgreSQL/WAL e storage oggetti (`disposition: "external"` in [rea-coverage-manifest.json](rea-coverage-manifest.json)). |
| Sincronizzazione LDAP | Configurazione LDAP e avvio manuale del sync utenti dalla gestione utenti. [Configurazione](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web.php#L429-L443), [Sync utenti](https://github.com/grokability/snipe-it/blob/576e1c3c9e1ad67b7c7d53dcde49b9b7b5d253f8/routes/web/users.php#L9-L27) | Provisioning JIT al login e provisioning push di utenti e gruppi via SCIM 2.0 nel Piano 4.2. La directory resta gestita dall'IdP. [Piano 4.2](../PLAN.md) |

## 4. Architettura Reattiva in Angular (Signals + RBAC + FMCS)

1. **`AuthStore` (Angular Signal Store in `core/auth/auth.store.ts`)**:
   - Mantiene `currentUser = signal<AuthenticatedUserContext | null>(null)` insieme ai segnali derivati (`isAuthenticated`, `isSuperUser`, `isAdmin`, `userCompanyIds`).
   - Espone il metodo `can(permission: PermissionKey): boolean` che valuta le stesse regole RBAC condivise in `@kestrel-it/shared`.
2. **Reattività Company-Scoped (FMCS nei Form)**:
   - I selettori di sedi, dipartimenti e utenti ricaricano le opzioni quando cambia l'azienda del form. Per i form utente, un'appartenenza aziendale singola fornisce il filtro.
   - I drawer di checkout e check-in usano l'azienda dell'asset per caricare destinatari e sedi di rientro. I filtri delle selectlist seguono le regole FMCS del server, inclusi i record floater e le sedi condivise.
