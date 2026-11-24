INSERT INTO maintenance_types (name, is_system)
SELECT name, true FROM (VALUES ('Maintenance'), ('Repair'), ('Upgrade'), ('PAT Test'),
  ('Calibration'), ('Software Support'), ('Hardware Support'), ('Configuration Change')) AS built_in(name)
WHERE NOT EXISTS (
  SELECT 1 FROM maintenance_types mt WHERE lower(mt.name) = lower(built_in.name) AND mt.deleted_at IS NULL
);
--> statement-breakpoint
CREATE FUNCTION kestrel_sync_calendar(source_kind text, record_id integer, source_row jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  event record;
  begins timestamptz;
  ends timestamptz;
  company integer;
  all_day boolean;
BEGIN
  IF source_row IS NULL OR source_row->>'deleted_at' IS NOT NULL
      OR (source_kind = 'checkout_request' AND source_row->>'state' = 'canceled') THEN
    DELETE FROM calendar_events WHERE source_type = source_kind AND source_id = record_id;
    RETURN;
  END IF;

  company := (source_row->>'company_id')::integer;
  IF source_kind = 'maintenance' THEN
    SELECT company_id INTO company FROM assets WHERE id = (source_row->>'item_id')::integer;
  ELSIF source_kind = 'checkout_request' AND source_row->>'requestable_type' = 'asset' THEN
    SELECT company_id INTO company FROM assets WHERE id = (source_row->>'requestable_id')::integer;
  END IF;

  FOR event IN SELECT * FROM (VALUES
    ('asset', 'next_audit_date', 'asset.audit_due', NULL),
    ('asset', 'expected_checkin', 'asset.expected_checkin', NULL),
    ('asset', 'last_checkout', 'asset.checkout', NULL),
    ('asset', 'asset_eol_date', 'asset.eol', NULL),
    ('asset', 'warranty_expires', 'asset.warranty_expiration', NULL),
    ('license', 'expiration_date', 'license.expiration', NULL),
    ('license', 'termination_date', 'license.termination', NULL),
    ('maintenance', 'start_date', 'maintenance.start', 'expected_completion_date'),
    ('user', 'start_date', 'user.start_date', NULL),
    ('user', 'end_date', 'user.end_date', NULL),
    ('checkout_request', 'start_date', 'request.reservation', 'end_date')
  ) AS definitions(kind, field, event_type, end_field) WHERE kind = source_kind
  LOOP
    all_day := event.field <> 'last_checkout';
    IF event.field = 'warranty_expires' THEN
      begins := CASE WHEN (source_row->>'warranty_months')::integer > 0
        THEN ((source_row->>'purchase_date')::date +
          make_interval(months => (source_row->>'warranty_months')::integer)) AT TIME ZONE 'UTC' END;
    ELSIF all_day THEN
      begins := (source_row->>event.field)::date::timestamp AT TIME ZONE 'UTC';
    ELSE
      begins := (source_row->>event.field)::timestamptz;
    END IF;
    ends := ((source_row->>event.end_field)::date + 1)::timestamp AT TIME ZONE 'UTC';

    IF begins IS NULL THEN
      DELETE FROM calendar_events WHERE source_type = source_kind AND source_id = record_id
        AND source_field = event.field;
    ELSE
      INSERT INTO calendar_events (source_type, source_id, source_field, event_type, start, "end", company_id)
      VALUES (source_kind, record_id, event.field, event.event_type, begins, ends, company)
      ON CONFLICT (source_type, source_id, source_field) DO UPDATE
        SET event_type = EXCLUDED.event_type, start = EXCLUDED.start, "end" = EXCLUDED."end",
          company_id = EXCLUDED.company_id, updated_at = now(), deleted_at = NULL
        WHERE (calendar_events.event_type, calendar_events.start, calendar_events."end", calendar_events.company_id,
          calendar_events.deleted_at) IS DISTINCT FROM (EXCLUDED.event_type, EXCLUDED.start, EXCLUDED."end",
          EXCLUDED.company_id, NULL::timestamptz);
    END IF;
  END LOOP;

  IF source_kind = 'asset' THEN
    UPDATE calendar_events AS events SET company_id = company, updated_at = now()
    WHERE events.company_id IS DISTINCT FROM company AND (
      (events.source_type = 'maintenance' AND EXISTS (
        SELECT 1 FROM asset_maintenances WHERE id = events.source_id AND item_id = record_id
      )) OR (events.source_type = 'checkout_request' AND EXISTS (
        SELECT 1 FROM checkout_requests WHERE id = events.source_id
          AND requestable_type = 'asset' AND requestable_id = record_id
      ))
    );
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION kestrel_calendar_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM kestrel_sync_calendar(TG_ARGV[0], OLD.id, NULL);
  ELSE
    PERFORM kestrel_sync_calendar(TG_ARGV[0], NEW.id, to_jsonb(NEW));
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER calendar_assets AFTER INSERT OR DELETE OR UPDATE OF next_audit_date, expected_checkin, last_checkout,
  asset_eol_date, warranty_months, purchase_date, company_id, deleted_at ON assets
  FOR EACH ROW EXECUTE FUNCTION kestrel_calendar_trigger('asset');
--> statement-breakpoint
CREATE TRIGGER calendar_licenses AFTER INSERT OR DELETE OR UPDATE OF expiration_date, termination_date, company_id, deleted_at
  ON licenses FOR EACH ROW EXECUTE FUNCTION kestrel_calendar_trigger('license');
--> statement-breakpoint
CREATE TRIGGER calendar_maintenances AFTER INSERT OR DELETE OR UPDATE OF start_date, expected_completion_date,
  item_id, deleted_at ON asset_maintenances FOR EACH ROW EXECUTE FUNCTION kestrel_calendar_trigger('maintenance');
--> statement-breakpoint
CREATE TRIGGER calendar_users AFTER INSERT OR DELETE OR UPDATE OF start_date, end_date, deleted_at
  ON users FOR EACH ROW EXECUTE FUNCTION kestrel_calendar_trigger('user');
--> statement-breakpoint
CREATE TRIGGER calendar_requests AFTER INSERT OR DELETE OR UPDATE OF start_date, end_date, state, requestable_id,
  requestable_type, deleted_at ON checkout_requests FOR EACH ROW EXECUTE FUNCTION kestrel_calendar_trigger('checkout_request');
--> statement-breakpoint
SELECT kestrel_sync_calendar('asset', id, to_jsonb(assets)) FROM assets WHERE deleted_at IS NULL;
--> statement-breakpoint
SELECT kestrel_sync_calendar('license', id, to_jsonb(licenses)) FROM licenses WHERE deleted_at IS NULL;
--> statement-breakpoint
SELECT kestrel_sync_calendar('maintenance', id, to_jsonb(asset_maintenances)) FROM asset_maintenances WHERE deleted_at IS NULL;
--> statement-breakpoint
SELECT kestrel_sync_calendar('user', id, to_jsonb(users)) FROM users WHERE deleted_at IS NULL;
--> statement-breakpoint
SELECT kestrel_sync_calendar('checkout_request', id, to_jsonb(checkout_requests)) FROM checkout_requests WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TEMP VIEW kestrel_legacy_acquisitions AS
SELECT inventory.* FROM (
  SELECT 'asset' AS kind, id, company_id, supplier_id, btrim(order_number) AS number,
    1 AS qty, purchase_date, purchase_cost AS cost, created_by FROM assets WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'license', id, company_id, supplier_id, btrim(order_number), seats, purchase_date, purchase_cost, created_by
    FROM licenses WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'accessory', id, company_id, default_supplier_id, btrim(legacy_order_number), qty, legacy_purchase_date,
    default_purchase_cost, created_by FROM accessories WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'consumable', id, company_id, default_supplier_id, btrim(legacy_order_number), qty, legacy_purchase_date,
    default_purchase_cost, created_by FROM consumables WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'component', id, company_id, default_supplier_id, btrim(legacy_order_number), qty, legacy_purchase_date,
    default_purchase_cost, created_by FROM components WHERE deleted_at IS NULL
) inventory WHERE number <> '' AND qty > 0 AND NOT EXISTS (
  SELECT 1 FROM order_items WHERE item_type = inventory.kind AND item_id = inventory.id
);
--> statement-breakpoint
INSERT INTO orders (order_number, company_id, supplier_id, purchase_date, created_by)
SELECT legacy.number, legacy.company_id, legacy.supplier_id, min(legacy.purchase_date), min(legacy.created_by)
FROM kestrel_legacy_acquisitions legacy WHERE NOT EXISTS (
  SELECT 1 FROM orders existing WHERE existing.deleted_at IS NULL AND existing.order_number = legacy.number
    AND existing.company_id IS NOT DISTINCT FROM legacy.company_id
    AND existing.supplier_id IS NOT DISTINCT FROM legacy.supplier_id
)
GROUP BY legacy.number, legacy.company_id, legacy.supplier_id;
--> statement-breakpoint
INSERT INTO order_items (order_id, item_type, item_id, quantity, unit_cost, currency, purchase_date, created_by)
SELECT acquisition.id, legacy.kind, legacy.id, legacy.qty, legacy.cost,
  (SELECT default_currency FROM settings ORDER BY id LIMIT 1), legacy.purchase_date, legacy.created_by
FROM kestrel_legacy_acquisitions legacy JOIN LATERAL (
  SELECT id FROM orders WHERE deleted_at IS NULL AND order_number = legacy.number
    AND company_id IS NOT DISTINCT FROM legacy.company_id AND supplier_id IS NOT DISTINCT FROM legacy.supplier_id
  ORDER BY id LIMIT 1
) acquisition ON true;
--> statement-breakpoint
DROP VIEW kestrel_legacy_acquisitions;
