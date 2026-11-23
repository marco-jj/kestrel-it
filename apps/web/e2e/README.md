# Verifica browser della Fase 2

Usare un'istanza di test dedicata con il frontend Angular e `/api/v1` sullo stesso origin. Completare il setup con un superuser locale senza secondo fattore e lasciare FMCS disattivato. Lo scenario crea fixture di inventario, utenti di test e artefatti di firma.

Nel database dell'istanza di test abilitare la firma dopo il setup.

```sql
UPDATE settings
SET require_accept_signature = true
WHERE id = (SELECT min(id) FROM settings);
```

Dalla root del repository, installare Chromium e lanciare lo scenario.

```sh
pnpm --filter @kestrel-it/web exec playwright install chromium
export KESTREL_E2E_URL=http://localhost:4200
export KESTREL_E2E_USERNAME=browseradmin
# Impostare KESTREL_E2E_PASSWORD con la password del superuser di test.
pnpm --filter @kestrel-it/web test:e2e
```

Per usare Chromium già installato, impostare `KESTREL_E2E_CHROMIUM` sul percorso dell'eseguibile. Lo scenario verifica i permessi separati per le azioni bulk della directory, il ripristino, il cambio di modello con conferma, i custom field comuni in bulk e il checkout con firma in presenza e download del PDF.
