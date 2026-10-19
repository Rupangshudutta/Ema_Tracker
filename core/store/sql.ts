// The one thing the notebook needs from a database. Two implementations:
//   Cloudflare  Durable Object SQLite (runtimes/cloudflare/tracker.ts)
//   Docker      node:sqlite (runtimes/docker/sqlite.ts)
// Both are synchronous SQLite, so the same SQL and the same Store code run on either.

export type SqlValue = string | number | null;

export interface SqlDriver {
  /** Runs one statement and returns its rows (empty for writes). */
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** Runs one write statement; true when it changed at least one row. */
  run(sql: string, ...params: SqlValue[]): boolean;
  /** Runs `fn` atomically and rolls back if it throws. `fn` must be synchronous (no awaits inside). */
  transaction<T>(fn: () => T): T;
}
