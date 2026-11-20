# 02 — Custom Fields & Fieldsets Engine (`JSONB` + GIN + Dynamic Zod)

Questo documento mappa il funzionamento esatto del sottosistema **Custom Fields & Fieldsets** di Snipe-IT ([`app/Models/CustomField.php`](file:///Users/thor/development/snipe-it/app/Models/CustomField.php), [`app/Models/CustomFieldset.php`](file:///Users/thor/development/snipe-it/app/Models/CustomFieldset.php), [`app/Http/Transformers/CustomFieldValuesTransformer.php`](file:///Users/thor/development/snipe-it/app/Http/Transformers/CustomFieldValuesTransformer.php)) e specifica la sua reimplementazione su **PostgreSQL `JSONB`** in Kestrel-IT.

---

## 1. Come Funziona in Snipe-IT (Comportamento Osservato)

In [`CustomField.php`](file:///Users/thor/development/snipe-it/app/Models/CustomField.php#L324-L448):
1. Quando un amministratore crea un `CustomField` (es. `"MAC Address"` con `id = 1`), l'hook Eloquent `self::created` genera uno slug Unicode (`convertUnicodeDbSlug()`):
   - Formato: `_snipeit_<slug_max_50_chars>_<id>` (es. `_snipeit_mac_address_1`).
   - Esegue un `ALTER TABLE assets ADD COLUMN _snipeit_mac_address_1 TEXT NULL` (oppure `DATE` / `DATETIME` se il formato è `DATE` o `DATETIME`).
2. Quando il nome cambia (`self::updating`), esegue `ALTER TABLE assets RENAME COLUMN ...`.
3. Quando il campo viene eliminato (`self::deleting`), esegue `ALTER TABLE assets DROP COLUMN ...`.
4. **Blocco cambio formato (`DATE`/`DATETIME`)**: In Snipe-IT non è possibile cambiare il formato di un campo esistente da/verso `DATE` o `DATETIME` perché MySQL fallirebbe il cast DDL della colonna fisica.

### 1.1 Elementi UI Supportati (`ELEMENT_KEYS`)
Estratti da [`CustomField::ELEMENT_KEYS`](file:///Users/thor/development/snipe-it/app/Models/CustomField.php#L63-L66):
- `'text'` — Input testuale singolo
- `'listbox'` — Select dropdown singolo (richiede `field_values`, opzioni separate da newline `\n`, con supporto opzionale `valore|etichetta`)
- `'textarea'` — Area di testo semplice
- `'markdown-textarea'` — Area di testo con rendering Markdown sanitized in lettura
- `'checkbox'` — Scelta multipla (richiede `field_values`)
- `'radio'` — Scelta singola radio (richiede `field_values`)
- `'date_picker'` — Selettore data (`YYYY-MM-DD`)
- `'datetime_picker'` — Selettore data e ora (`YYYY-MM-DD HH:mm:ss`)

### 1.2 Formati di Validazione (`PREDEFINED_FORMATS`) e Matrice di Compatibilità
Estratti da [`CustomField::PREDEFINED_FORMATS`](file:///Users/thor/development/snipe-it/app/Models/CustomField.php#L33-L71) e `allowedElementKeysForFormat()`:

| Formato (`format`) | Regola di Validazione | Elementi Consentiti (`element`) | Crittografia Consentita (`canEncryptFor`) | Icona UI (`iconForFormat`) |
| :--- | :--- | :--- | :--- | :--- |
| `ANY` (`""`) | Qualsiasi valore | Tutti gli 8 elementi | Sì (tranne `checkbox`, `radio`) | `null` |
| `ALPHA` | Solo lettere (`/^[a-zA-Z]+$/`) | Solo `'text'` | Sì | `null` |
| `ALPHA-DASH` | Lettere, numeri, `-`, `_` (`/^[a-zA-Z0-9_-]+$/`) | Solo `'text'` | Sì | `null` |
| `NUMERIC` | Numero intero o decimale | Solo `'text'` | Sì | `null` |
| `ALPHA-NUMERIC` | Lettere e numeri (`/^[a-zA-Z0-9]+$/`) | Solo `'text'` | Sì | `null` |
| `EMAIL` | Email valida | Solo `'text'` | Sì | `'email'` |
| `DATE` | Data ISO `YYYY-MM-DD` | Solo `'date_picker'` | **No** | `null` |
| `DATETIME` | Data/ora `YYYY-MM-DD HH:mm:ss` | Solo `'datetime_picker'` | **No** | `null` |
| `URL` | URL `http://` o `https://` valido | Solo `'text'` | Sì | `'link'` |
| `IP` | IPv4 o IPv6 valido | Solo `'text'` | Sì | `null` |
| `IPV4` | IPv4 valido | Solo `'text'` | Sì | `null` |
| `IPV6` | IPv6 valido | Solo `'text'` | Sì | `null` |
| `MAC` | `/^[a-fA-F0-9]{2}(:[a-fA-F0-9]{2}){5}$/` | Solo `'text'` | Sì | `null` |
| `BOOLEAN` | Booleano (`true`/`false`/`1`/`0`) | `'text'`, `'checkbox'`, `'radio'` | Sì per `'text'`, **No** per `'checkbox'`/`'radio'` | `null` |
| `PHONE` | Qualsiasi stringa telefonica | Solo `'text'` | Sì | `'phone'` |
| `FAX` | Qualsiasi stringa fax | Solo `'text'` | Sì | `'fax'` |
| `CUSTOM REGEX` (`regex:/.../`) | Espressione regolare custom fornita dall'utente | Solo `'text'` | Sì | `null` |

### 1.3 Flag di Visibilità e Comportamento del Campo
Ogni `CustomField` possiede 9 flag booleani:
- `field_encrypted`: Il valore viene cifrato a riposo nel DB e mostrato in chiaro **solo** agli utenti con permesso `assets.view.encrypted_custom_fields` (altrimenti viene restituita la stringa `"ENCRYPTED"`).
- `is_unique`: Il valore inserito deve essere univoco tra tutti gli Asset non eliminati (`deleted_at IS NULL`).
- `auto_add_to_fieldsets`: Quando viene creato un nuovo `CustomFieldset`, questo campo vi viene aggiunto automaticamente.
- `show_in_listview`: Mostra la colonna nella tabella generale degli Asset.
- `show_in_email`: Include il valore nelle email di notifica Checkout/Checkin.
- `show_in_requestable_list`: Include il valore nella tabella degli asset richiedibili dagli utenti (`/account/requestable`, filtrato in [`AssetsTransformer::transformRequestedAsset`](file:///Users/thor/development/snipe-it/app/Http/Transformers/AssetsTransformer.php#L321-L327) con `includeEncrypted: false`).
- `display_in_user_view`: Mostra il campo all'utente assegnatario nella propria pagina profilo `/account/view-assets`.
- `display_checkout`: Mostra e permette la modifica del campo durante il form di **Checkout**.
- `display_checkin`: Mostra e permette la modifica del campo durante il form di **Checkin**.
- `display_audit`: Mostra e permette la modifica del campo durante il form di **Audit**.

---

## 2. Architettura `JSONB` in Kestrel-IT (PostgreSQL + Drizzle)

### 2.1 Struttura di Archiviazione su `assets.custom_fields`
Invece di eseguire `ALTER TABLE`, la tabella `assets` ha una colonna `custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb`:
- **Chiave nel documento JSONB:** Manteniamo `db_column` (es. `"_snipeit_mac_address_1"`) come chiave nel JSONB!
  - **Perché usare `db_column` come chiave JSONB:**
    1. Garantisce **compatibilità 100% con i client API di Snipe-IT** che inviano payload `{ "_snipeit_mac_address_1": "AA:BB:CC:DD:EE:FF" }` in `POST /api/v1/hardware` e `PATCH /api/v1/hardware/{id}`.
    2. Se l'amministratore rinomina la label visuale del campo (`name`), non occorre riscrivere tutte le righe della tabella `assets` o si può aggiornare la chiave in modo atomico con `jsonb_set`.
    3. La migrazione da MySQL (Fase 4) diventa una semplice aggregazione `jsonb_build_object` delle colonne `_snipeit_*` esistenti.

```sql
-- Indice GIN su PostgreSQL per ricerche istantanee su qualsiasi Custom Field
CREATE INDEX idx_assets_custom_fields_gin ON assets USING GIN (custom_fields jsonb_path_ops);
```

### 2.2 Compilatore Dinamico Zod (`packages/shared/src/schemas/custom-field-validator.ts`)
Quando un Asset viene creato o aggiornato (o durante Checkout/Checkin/Audit), `CustomFieldsValidationService` carica il `CustomFieldset` associato a `asset.model.fieldsetId` (con i relativi `fields` e il flag `pivot.required`) e costruisce dinamicamente lo schema Zod:

```ts
import { z } from 'zod';

export function buildCustomFieldZodSchema(field: CustomFieldDefinition, isRequiredInFieldset: boolean) {
  let schema: z.ZodTypeAny;

  switch (field.format) {
    case 'EMAIL':
      schema = z.string().email();
      break;
    case 'URL':
      schema = z.string().url();
      break;
    case 'NUMERIC':
      schema = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
      break;
    case 'ALPHA':
      schema = z.string().regex(/^[a-zA-Z]+$/);
      break;
    case 'ALPHA-DASH':
      schema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
      break;
    case 'ALPHA-NUMERIC':
      schema = z.string().regex(/^[a-zA-Z0-9]+$/);
      break;
    case 'MAC':
      schema = z.string().regex(/^[a-fA-F0-9]{2}(:[a-fA-F0-9]{2}){5}$/);
      break;
    case 'DATE':
      schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      break;
    case 'DATETIME':
      schema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      break;
    case 'IPV4':
      schema = z.string().ip({ version: 'v4' });
      break;
    case 'IPV6':
      schema = z.string().ip({ version: 'v6' });
      break;
    case 'IP':
      schema = z.string().ip();
      break;
    case 'BOOLEAN':
      schema = z.union([z.boolean(), z.enum(['0', '1', 'true', 'false'])]);
      break;
    default:
      if (field.format?.startsWith('regex:')) {
        const rawPattern = field.format.replace(/^regex:\//, '').replace(/\/$/, '');
        schema = z.string().regex(new RegExp(rawPattern));
      } else {
        schema = z.string();
      }
  }

  // Validazione opzioni per listbox / radio / checkbox
  if (['listbox', 'radio', 'checkbox'].includes(field.element) && field.allowedOptions?.length) {
    // Verifica che i valori scelti appartengano a field_values
  }

  return isRequiredInFieldset ? schema : schema.nullable().optional();
}
```

### 2.3 Gestione di `is_unique` e `field_encrypted` su JSONB
1. **Validazione `is_unique`:**
   Per i campi con `isUnique = true`, il servizio esegue una query Drizzle su PostgreSQL prima del salvataggio:
   ```sql
   SELECT id FROM assets
   WHERE deleted_at IS NULL
     AND id != $currentAssetId
     AND custom_fields ->> $dbColumn = $submittedValue
   LIMIT 1;
   ```
2. **Crittografia `field_encrypted`:**
   - I campi con `fieldEncrypted = true` vengono cifrati tramite **AES-256-GCM** (`enc:v1:<iv>:<authTag>:<ciphertext>`) prima di essere scritti in `assets.custom_fields[dbColumn]`.
   - In fase di serializzazione (`CustomFieldValuesTransformer`), se il campo è cifrato:
     - Se l'utente ha il permesso `assets.view.encrypted_custom_fields`, il valore viene decifrato al volo.
     - Altrimenti viene restituita la stringa `"ENCRYPTED"` (esattamente come in [`CustomFieldValuesTransformer.php`](file:///Users/thor/development/snipe-it/app/Http/Transformers/CustomFieldValuesTransformer.php#L32-L34)).

### 2.4 Formato di Serializzazione API (`custom_fields` in `AssetsTransformer`)
Per mantenere la compatibilità al 100% con l'API di Snipe-IT, l'oggetto `custom_fields` restituito in `GET /api/v1/hardware` mantiene la struttura esatta di `CustomFieldValuesTransformer`:

```json
{
  "custom_fields": {
    "MAC Address": {
      "field": "_snipeit_mac_address_1",
      "value": "AA:BB:CC:DD:EE:FF",
      "field_format": "MAC",
      "element": "text"
    }
  }
}
```
E quando l'asset non ha custom fields, restituisce un oggetto vuoto `{}` (mai un array `[]`).
