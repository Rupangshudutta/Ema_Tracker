// node:sqlite implementation of the notebook's database driver (Docker spare and tests).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from '../../core/store/sql.ts';

export interface ClosableSqlDriver extends SqlDriver {
  close(): void;
}

/** Opens (or creates) a database file; ':memory:' gives a throwaway database for tests. */
export function openSqlite(path: string): ClosableSqlDriver {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };
  return {
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      // node:sqlite rows have a null prototype; copy them into plain objects.
      return prepare(sql).all(...params).map(row => ({ ...row }) as T);
    },
    run(sql: string, ...params: SqlValue[]): boolean {
      return Number(prepare(sql).run(...params).changes) > 0;
    },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close(): void {
      statements.clear();
      db.close();
    }
  };
}
