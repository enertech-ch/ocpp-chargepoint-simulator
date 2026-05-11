// Thin localStorage facade for UI preferences. Schema-free; values are JSON.
// Saved-message library uses IndexedDB instead (see src/lib/idb.js).

const NS = 'ocpp-sim:';

export const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch {}
  },
  remove(key) {
    try { localStorage.removeItem(NS + key); } catch {}
  },
};
