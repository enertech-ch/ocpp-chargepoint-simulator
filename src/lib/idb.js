// Tiny IndexedDB wrapper. DB `ocpp-sim`, two stores:
//   - sequences:   recorded step lists you can run against any CP
//   - scripts:     user-written JavaScript snippets (incl. built-ins)
//
//   const db = await openDB();
//   await db.put('sequences', { label, steps, ... });
//   await db.getAll('sequences');

const DB_NAME = 'ocpp-sim';
const DB_VERSION = 1;

const SCHEMA = {
  sequences: { keyPath: 'id', autoIncrement: true, indexes: [
    { name: 'by_label', keyPath: 'label', unique: false },
  ] },
  scripts: { keyPath: 'id', autoIncrement: true, indexes: [
    { name: 'by_label', keyPath: 'label', unique: false },
  ] },
};

let _dbPromise;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(SCHEMA)) {
        const store = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: def.autoIncrement });
        for (const idx of def.indexes || []) {
          store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
        }
      }
    };
    req.onsuccess = () => resolve(wrap(req.result));
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function wrap(db) {
  return {
    raw: db,
    put: (store, value) => tx(db, store, 'readwrite', (s) => s.put(value)),
    add: (store, value) => tx(db, store, 'readwrite', (s) => s.add(value)),
    get: (store, key) => tx(db, store, 'readonly', (s) => s.get(key)),
    getAll: (store) => tx(db, store, 'readonly', (s) => s.getAll()),
    delete: (store, key) => tx(db, store, 'readwrite', (s) => s.delete(key)),
    clear: (store) => tx(db, store, 'readwrite', (s) => s.clear()),
  };
}

function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
