// ═══════════════════════════════════════════════════════════════
//  db.js — BizTrack Pro SQLite Database Layer
//  Plugin:  @capacitor-community/sqlite v6
//  Pattern: In-memory cache loaded at startup; write-through on mutation
//  Fallback: localStorage (for browser dev / web testing)
//  UTF-8:   All strings stored via parameterised executeSet() calls —
//           the SQLite driver never mangles multibyte characters.
// ═══════════════════════════════════════════════════════════════
'use strict';

// ─── GLOBAL IN-MEMORY DATA MODEL ─────────────────────────────
// Identical shape to the original localStorage DB so that main.js
// can read DB.sales, DB.inventory etc. without any changes.
window.DB = {
  settings: {
    bizName:        'My Business',
    owner:          '',
    type:           'General Shop',
    currency:       'UGX',
    payTerms:       30,
    taxRate:        0,
    lowStock:       5,
    invoiceFooter:  'Thank you for your business!'
  },
  sales:      [],
  inventory:  [],
  suppliers:  [],
  customers:  [],
  expenses:   [],
  returns:    []
};

// ─── DATABASE NAME & VERSION ──────────────────────────────────
const DB_NAME    = 'biztrack_v3';
const DB_VERSION = 1;

// ─── SQL SCHEMA (CREATE IF NOT EXISTS — safe to re-run) ───────
// Each table stores a JSON blob per record identified by a TEXT PK.
// Storing full JSON keeps the schema simple and future-proof while
// still benefiting from native SQLite ACID transactions.
// The `settings` table uses key/value pairs for the config object.
const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS sales (
    id   TEXT NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS inventory (
    id   TEXT NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS expenses (
    id   TEXT NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS suppliers (
    id   TEXT NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS customers (
    name TEXT NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS returns (
    id   TEXT NOT NULL PRIMARY KEY,
    data TEXT NOT NULL
  ) WITHOUT ROWID;
`;

// ─── BizDB — public API ───────────────────────────────────────
window.BizDB = {

  _plugin: null,    // CapacitorSQLite plugin reference
  _ready:  false,   // true once init() finishes

  // ──────────────────────────────────────────────────────────
  // init()
  // Call once at app startup (async). Resolves when data is
  // loaded into memory and the app can render.
  // ──────────────────────────────────────────────────────────
  async init() {
    _setLoadingStatus('Opening database…');

    // Obtain the plugin handle
    const plugin = window?.Capacitor?.Plugins?.CapacitorSQLite;

    if (!plugin) {
      // Running in a plain browser (development / GitHub Pages)
      console.warn('[BizDB] CapacitorSQLite not found — using localStorage fallback.');
      _loadFromLocalStorage();
      this._ready = true;
      return;
    }

    this._plugin = plugin;

    try {
      // 1. Create and open the connection
      _setLoadingStatus('Creating connection…');
      await this._plugin.createConnection({
        database:  DB_NAME,
        encrypted: false,
        mode:      'no-encryption',
        version:   DB_VERSION,
        readonly:  false
      });

      _setLoadingStatus('Opening database…');
      await this._plugin.open({ database: DB_NAME });

      // 2. Create tables (idempotent)
      _setLoadingStatus('Initialising schema…');
      await this._plugin.execute({
        database:    DB_NAME,
        statements:  SCHEMA_SQL,
        transaction: true
      });

      // 3. Load all data into memory
      _setLoadingStatus('Loading your data…');
      await this._loadAll();

      this._ready = true;
      _setLoadingStatus('Ready!');

    } catch (err) {
      console.error('[BizDB] init error:', err);
      // Graceful degradation: fall back to localStorage
      _loadFromLocalStorage();
      this._ready = true;
    }
  },

  // ──────────────────────────────────────────────────────────
  // save()
  // Flush the entire in-memory DB to SQLite in one transaction.
  // Fire-and-forget safe; caller does not need to await.
  // ──────────────────────────────────────────────────────────
  async save() {
    if (!this._plugin || !this._ready) {
      _saveToLocalStorage();
      return;
    }

    try {
      // Build a parameterised set — this guarantees correct UTF-8
      // encoding for ALL string values including emoji and special chars.
      const set = [];

      // ── settings rows ──
      for (const [k, v] of Object.entries(DB.settings)) {
        set.push({
          statement: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);',
          values:    [k, JSON.stringify(v)]
        });
      }

      // ── array tables ──
      const TABLES = [
        { name: 'sales',     pk: 'id' },
        { name: 'inventory', pk: 'id' },
        { name: 'expenses',  pk: 'id' },
        { name: 'suppliers', pk: 'id' },
        { name: 'customers', pk: 'name' },
        { name: 'returns',   pk: 'id'  }
      ];

      for (const { name, pk } of TABLES) {
        // Delete rows that are no longer in memory (handles deletions)
        const liveKeys = DB[name].map(r => String(r[pk] ?? '')).filter(Boolean);
        if (liveKeys.length === 0) {
          // Wipe the table
          set.push({ statement: `DELETE FROM ${name};`, values: [] });
        } else {
          // Delete any stale rows not in current set
          const placeholders = liveKeys.map(() => '?').join(',');
          set.push({
            statement: `DELETE FROM ${name} WHERE ${pk} NOT IN (${placeholders});`,
            values:    liveKeys
          });
        }

        // Upsert all live rows
        for (const record of DB[name]) {
          const keyVal = String(record[pk] ?? '');
          if (!keyVal) continue;
          set.push({
            statement: `INSERT OR REPLACE INTO ${name} (${pk}, data) VALUES (?, ?);`,
            values:    [keyVal, JSON.stringify(record)]
          });
        }
      }

      if (set.length > 0) {
        await this._plugin.executeSet({
          database:    DB_NAME,
          set:         set,
          transaction: true
        });
      }

    } catch (err) {
      console.error('[BizDB] save error:', err);
      // Always try localStorage as last resort
      _saveToLocalStorage();
    }
  },

  // ──────────────────────────────────────────────────────────
  // exportJSON() — returns JSON string of full DB for download
  // ──────────────────────────────────────────────────────────
  exportJSON() {
    return JSON.stringify(DB, null, 2);
  },

  // ──────────────────────────────────────────────────────────
  // importJSON(jsonString) — replace in-memory + persist
  // ──────────────────────────────────────────────────────────
  async importJSON(jsonString) {
    const parsed = JSON.parse(jsonString); // may throw — caller should catch
    window.DB = Object.assign(DB, parsed);
    DB.settings = Object.assign({}, {
      bizName: 'My Business', owner: '', type: 'General Shop',
      currency: 'UGX', payTerms: 30, taxRate: 0,
      lowStock: 5, invoiceFooter: 'Thank you for your business!'
    }, parsed.settings || {});
    await this.save();
  },

  // ──────────────────────────────────────────────────────────
  // _loadAll() — read every table from SQLite into window.DB
  // ──────────────────────────────────────────────────────────
  async _loadAll() {
    // Settings
    const sr = await this._plugin.query({
      database:  DB_NAME,
      statement: 'SELECT key, value FROM settings;',
      values:    []
    });
    if (sr?.values?.length > 0) {
      const s = {};
      for (const row of sr.values) {
        try { s[row.key] = JSON.parse(row.value); } catch { s[row.key] = row.value; }
      }
      DB.settings = Object.assign(DB.settings, s);
    }

    // Array tables
    const TABLES = ['sales', 'inventory', 'expenses', 'suppliers', 'customers', 'returns'];
    for (const tbl of TABLES) {
      const res = await this._plugin.query({
        database:  DB_NAME,
        statement: `SELECT data FROM ${tbl};`,
        values:    []
      });
      if (res?.values?.length > 0) {
        DB[tbl] = res.values
          .map(r => { try { return JSON.parse(r.data); } catch { return null; } })
          .filter(Boolean);
      }
    }
  }
};

// ─── PRIVATE HELPERS ─────────────────────────────────────────

function _setLoadingStatus(msg) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg;
}

function _saveToLocalStorage() {
  try {
    localStorage.setItem('biztrack_v3_data', JSON.stringify(DB));
  } catch (e) {
    console.warn('[BizDB] localStorage save failed:', e);
  }
}

function _loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem('biztrack_v3_data');
    if (raw) {
      const parsed = JSON.parse(raw);
      window.DB = Object.assign(DB, parsed);
      DB.settings = Object.assign(DB.settings, parsed.settings || {});
      console.info('[BizDB] Loaded from localStorage (fallback mode).');
    }
  } catch (e) {
    console.warn('[BizDB] localStorage load failed:', e);
  }
}
