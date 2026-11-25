const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

export function formatDisplayDate(value: unknown, showTime = false): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? formatDisplayDate(value.toISOString(), showTime) : null;
  }
  if (value && typeof value === 'object') {
    if ('date' in value && typeof value.date === 'string') value = value.date;
    else if ('datetime' in value && typeof value.datetime === 'string') value = value.datetime;
  }
  if (typeof value !== 'string') return null;
  const parts = isoDate.exec(value);
  if (!parts) return null;
  const [, year, month, day, time] = parts;
  const date = `${day}/${month}/${year}`;
  return showTime && time ? `${date} ${time}` : date;
}

export function datePresentationForKey(key: string): 'date' | 'datetime' | undefined {
  if (/(?:_at|At)$/.test(key) || ['action_date', 'last_audit_date', 'last_checkout', 'last_checkin'].includes(key)) {
    return 'datetime';
  }
  if (key === 'date' || key.endsWith('_date') || key === 'expected_checkin') return 'date';
  return undefined;
}

export function parseDisplayDate(value: string, withTime = false): string | null {
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}:\d{2}(?::\d{2})?))?$/.exec(value.trim());
  if (!parts) return null;
  const [, day, month, year, time] = parts;
  if (Boolean(time) !== withTime) return null;
  const date = `${year}-${month}-${day}`;
  const timestamp = new Date(`${date}T${time ?? '00:00'}Z`);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const iso = time ? `${date}T${time}` : date;
  return timestamp.toISOString().startsWith(iso) && year !== '0000' ? iso : null;
}
