import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

// Two database contexts:
// - personalDb: the always-open default library (userData/data/veridian.db).
//   Also holds the workspaces REGISTRY (which workspaces exist) -- registry
//   reads/writes must use getPersonalDb() explicitly.
// - workspaceDb: the per-workspace index database, open only while a
//   workspace is active. For github-kind workspaces this is a DISPOSABLE
//   CACHE -- the human-readable files in the repo working tree are the
//   source of truth (see WorkspaceFiles.ts); deleting the index db loses
//   nothing that a re-import can't rebuild.
//
// getDb() routes to whichever is active, which is the entire trick that lets
// every existing repo/service work against a workspace unchanged (DIP: they
// depend on this accessor, never on a concrete database identity).
let personalDb: Database.Database | null = null
let workspaceDb: Database.Database | null = null

export function getDb(): Database.Database {
  const db = workspaceDb ?? personalDb
  if (!db) throw new Error('Database not initialized')
  return db
}

export function getPersonalDb(): Database.Database {
  if (!personalDb) throw new Error('Database not initialized')
  return personalDb
}

function open(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

export async function initDatabase(): Promise<void> {
  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  personalDb = open(join(dataDir, 'veridian.db'))
}

/** Open (creating if needed) a workspace index db and make it the active context. */
export function openWorkspaceDb(dbPath: string): void {
  closeWorkspaceDb()
  workspaceDb = open(dbPath)
}

/** Close any active workspace db; getDb() falls back to the personal library. */
export function closeWorkspaceDb(): void {
  if (workspaceDb) {
    try { workspaceDb.close() } catch { /* already closed */ }
    workspaceDb = null
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `)

  const current = (
    db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }
  ).v ?? 0

  if (current < 1) {
    db.exec(`
      -- Libraries
      CREATE TABLE IF NOT EXISTS libraries (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'personal'
      );
      INSERT OR IGNORE INTO libraries (id, name, type) VALUES (1, 'My Library', 'personal');

      -- Collections
      CREATE TABLE IF NOT EXISTS collections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id  INTEGER NOT NULL REFERENCES libraries(id),
        parent_id   INTEGER REFERENCES collections(id),
        name        TEXT NOT NULL,
        key         TEXT NOT NULL UNIQUE
      );

      -- Items
      CREATE TABLE IF NOT EXISTS items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        type        TEXT NOT NULL,
        title       TEXT,
        abstract    TEXT,
        year        INTEGER,
        doi         TEXT,
        url         TEXT,
        journal     TEXT,
        publisher   TEXT,
        volume      TEXT,
        issue       TEXT,
        pages       TEXT,
        isbn        TEXT,
        language    TEXT,
        extra       TEXT,
        deleted     INTEGER NOT NULL DEFAULT 0,
        library_id  INTEGER NOT NULL DEFAULT 1 REFERENCES libraries(id),
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        version     INTEGER NOT NULL DEFAULT 0
      );

      -- Creators
      CREATE TABLE IF NOT EXISTS creators (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT,
        last_name  TEXT NOT NULL,
        orcid      TEXT
      );
      CREATE TABLE IF NOT EXISTS item_creators (
        item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        creator_id INTEGER NOT NULL REFERENCES creators(id),
        role       TEXT NOT NULL DEFAULT 'author',
        position   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (item_id, creator_id, role)
      );

      -- Tags
      CREATE TABLE IF NOT EXISTS tags (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS item_tags (
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        tag_id  INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY (item_id, tag_id)
      );

      -- Attachments
      CREATE TABLE IF NOT EXISTS attachments (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        type      TEXT NOT NULL,
        filename  TEXT,
        path      TEXT,
        url       TEXT,
        mime_type TEXT,
        size      INTEGER,
        md5       TEXT
      );

      -- Notes
      CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        content    TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- Collection <-> Item
      CREATE TABLE IF NOT EXISTS collection_items (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY (collection_id, item_id)
      );

      -- Sync state
      CREATE TABLE IF NOT EXISTS sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      -- Full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        title, abstract,
        content='items', content_rowid='id',
        tokenize='unicode61'
      );

      INSERT INTO schema_version VALUES (1);
    `)
  }

  if (current < 2) {
    // Add Phase 1 columns to items (ALTER TABLE is safe for nullable columns)
    const existingCols = (db.pragma('table_info(items)') as { name: string }[]).map((c) => c.name)
    const newCols: [string, string][] = [
      ['journal',   'TEXT'],
      ['publisher', 'TEXT'],
      ['volume',    'TEXT'],
      ['issue',     'TEXT'],
      ['pages',     'TEXT'],
      ['isbn',      'TEXT'],
      ['language',  'TEXT'],
      ['extra',     'TEXT'],
      ['deleted',   'INTEGER NOT NULL DEFAULT 0'],
    ]
    for (const [col, def] of newCols) {
      if (!existingCols.includes(col)) {
        db.exec(`ALTER TABLE items ADD COLUMN ${col} ${def}`)
      }
    }
    db.exec(`INSERT INTO schema_version VALUES (2)`)
  }

  if (current < 3) {
    // Sync-ready scaffolding: operation log for incremental upload / undo,
    // tombstones so permanent deletes can propagate to other devices.
    db.exec(`
      CREATE TABLE IF NOT EXISTS oplog (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        object_type TEXT NOT NULL,
        object_id   INTEGER NOT NULL,
        op          TEXT NOT NULL,
        payload     TEXT,
        ts          INTEGER NOT NULL DEFAULT (unixepoch()),
        synced      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_oplog_synced ON oplog(synced);

      CREATE TABLE IF NOT EXISTS tombstones (
        object_type TEXT NOT NULL,
        key         TEXT NOT NULL,
        ts          INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (object_type, key)
      );

      INSERT INTO schema_version VALUES (3);
    `)
  }

  if (current < 4) {
    // Local-first workspaces: a workspace is a row here, optionally bound to
    // a GitHub repository (kind='github'). Shared-workspace identity and
    // permissions are GitHub's own PAT + repo-collaborator model; 'local'
    // workspaces are private to this machine.
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'local',
        repo_owner TEXT,
        repo_name  TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      INSERT INTO schema_version VALUES (4);
    `)
  }
}
