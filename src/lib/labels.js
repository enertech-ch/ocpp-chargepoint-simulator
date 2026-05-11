// Name helpers shared by ChargePoints and sequences.
//
// `nextLabel('Foo', items, 'name')` → smallest "Foo #N" not already in use,
// so deletions leave gaps that future adds fill in.
//
// `copyName(source, items, 'name')` → "<base> (copy)" / "<base> (copy 2)" /...
// where <base> has any trailing "(copy …)" stripped. The new name must
// differ from *every* item, including the source itself.

// Smallest positive integer not already used as "<prefix> #N" in items[field].
export function nextNumber(prefix, items, field = 'label') {
  const re = new RegExp(`^${prefix} #(\\d+)$`);
  const used = new Set();
  for (const it of items) {
    const m = (it[field] || '').match(re);
    if (m) used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export function nextLabel(prefix, items, field = 'label') {
  return `${prefix} #${nextNumber(prefix, items, field)}`;
}

export function copyName(source, items, field = 'label') {
  const base = (source[field] || '').replace(/ \(copy(?: \d+)?\)$/, '');
  const used = new Set(items.map((it) => it[field] || ''));
  let candidate = `${base} (copy)`;
  let n = 2;
  while (used.has(candidate)) candidate = `${base} (copy ${n++})`;
  return candidate;
}
