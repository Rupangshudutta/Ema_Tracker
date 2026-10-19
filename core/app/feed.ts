// The live Delta price feed (v2/ticker), independent of how the socket is opened (Cloudflare fetch upgrade or Node's
// WebSocket). Fix for audit finding I8, plus what the S0 probe taught us on Cloudflare's shared IPs:
//   - Delta's heartbeat is enabled and 35 s of silence drops and reopens the connection
//   - connections that die quickly back off 2 s, 5 s, 15 s, 1 min, 5 min, 10 min (Delta: 150 connections per IP per
//     5 min, wait 5 to 10 min after a refusal), instead of retrying every 2 s
//   - coins are subscribed and unsubscribed in place as the watchlist changes; no coins means no connection
import { SYSTEM } from '../config/settings.ts';
import { diffSubscriptions, enableHeartbeatMessage, parseFeedMessage, subscribeMessage, unsubscribeMessage } from '../exchange/delta-feed.ts';

export interface FeedConnection {
  send(data: string): void;
  close(): void;
}

export interface FeedCallbacks {
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
}

/** Opens a connection to Delta's feed and wires its events to the callbacks; rejects if it cannot open. */
export type FeedOpener = (callbacks: FeedCallbacks) => Promise<FeedConnection>;

export interface FeedStatus {
  connected: boolean;
  wanted: number;
  /** When the feed went down (null while connected or idle with no coins). */
  downSince: number | null;
  lastMessageAt: number | null;
  quickDrops: number;
  nextConnectAt: number | null;
}

export interface FeedCounters {
  opens: number;
  drops: number;
  messages: number;
  downMs: number;
}

const STALE_MS = SYSTEM.realtime.feedStaleSeconds * 1000;
const HEALTHY_AFTER_MS = SYSTEM.realtime.healthyAfterSeconds * 1000;
const DELAYS_MS = SYSTEM.realtime.reconnectDelaysSeconds.map(s => s * 1000);

export class Feed {
  private readonly opener: FeedOpener;
  private readonly onTicker: (symbol: string, price: number, timestampMs: number) => void;
  private readonly now: () => number;
  private readonly log: (kind: string, detail: string) => void;
  private readonly wake: (at: number) => void;

  private conn: FeedConnection | null = null;
  private connecting = false;
  private generation = 0;
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private openedAt = 0;
  private lastMessageAt = 0;
  private downSince: number | null = null;
  private quickDrops = 0;
  private nextConnectAt = 0;
  private counters: FeedCounters = { opens: 0, drops: 0, messages: 0, downMs: 0 };

  constructor(opener: FeedOpener, onTicker: (symbol: string, price: number, timestampMs: number) => void, now: () => number, log: (kind: string, detail: string) => void, wake: (at: number) => void) {
    this.opener = opener;
    this.onTicker = onTicker;
    this.now = now;
    this.log = log;
    this.wake = wake;
  }

  /** Sets the coins to stream. Removing a coin unsubscribes it at once (its live updates stop). */
  setWanted(symbols: readonly string[]): void {
    const next = new Set(symbols);
    const same = next.size === this.wanted.size && [...next].every(s => this.wanted.has(s));
    this.wanted = next;
    if (!next.size) {
      if (this.conn) this.log('feed_idle', 'no coins to stream; connection closed');
      this.drop();
      this.endDowntime();
      return;
    }
    if (same && (this.conn || this.connecting)) return;
    if (this.conn) {
      const diff = diffSubscriptions(this.subscribed, next);
      try {
        if (diff.unsubscribe.length) this.conn.send(unsubscribeMessage(diff.unsubscribe));
        if (diff.subscribe.length) this.conn.send(subscribeMessage(diff.subscribe));
        this.subscribed = new Set(next);
      } catch (err) {
        this.log('feed_error', `resubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
        this.lost(false);
      }
      return;
    }
    this.markDown();
    this.wake(Math.max(this.now(), this.nextConnectAt));
  }

  /** Called on every wake-up: drops a silent connection and reconnects when the backoff allows. */
  async check(): Promise<void> {
    const now = this.now();
    if (this.conn && now - this.lastMessageAt > STALE_MS) {
      this.log('feed_stale', `no message for ${Math.round((now - this.lastMessageAt) / 1000)} s`);
      this.lost(now - this.openedAt < HEALTHY_AFTER_MS);
    }
    if (!this.conn && !this.connecting && this.wanted.size && now >= this.nextConnectAt) await this.connect();
  }

  /** When the host should wake the feed next (reconnect time, or the next silence check). */
  nextWakeAt(): number | null {
    if (!this.wanted.size) return null;
    if (this.conn) return this.lastMessageAt + STALE_MS + 1000;
    return this.connecting ? null : this.nextConnectAt;
  }

  status(): FeedStatus {
    return {
      connected: this.conn !== null,
      wanted: this.wanted.size,
      downSince: this.downSince,
      lastMessageAt: this.lastMessageAt || null,
      quickDrops: this.quickDrops,
      nextConnectAt: this.conn ? null : this.nextConnectAt || null
    };
  }

  /** Counters since the last call (for the daily report); downtime still running is counted up to now. */
  takeCounters(): FeedCounters {
    const now = this.now();
    const out = { ...this.counters };
    if (this.downSince !== null) {
      out.downMs += now - this.downSince;
      this.downSince = now;
    }
    this.counters = { opens: 0, drops: 0, messages: 0, downMs: 0 };
    return out;
  }

  close(): void {
    this.wanted = new Set();
    this.drop();
    this.endDowntime();
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    const gen = ++this.generation;
    try {
      const conn = await this.opener({
        onMessage: data => this.onMessage(gen, data),
        onClose: (code, reason) => {
          if (gen !== this.generation || !this.conn) return;
          this.log('feed_closed', `code ${code}${reason ? ` ${reason}` : ''} after ${Math.round((this.now() - this.openedAt) / 1000)} s`);
          this.lost(this.now() - this.openedAt < HEALTHY_AFTER_MS);
        }
      });
      if (gen !== this.generation || !this.wanted.size) {
        conn.close();
        return;
      }
      const now = this.now();
      this.conn = conn;
      this.openedAt = now;
      this.lastMessageAt = now;
      conn.send(enableHeartbeatMessage);
      conn.send(subscribeMessage([...this.wanted]));
      this.subscribed = new Set(this.wanted);
      this.counters.opens++;
      this.endDowntime();
      this.log('feed_open', `${this.wanted.size} coins${this.quickDrops ? ` (after ${this.quickDrops} quick drops)` : ''}`);
    } catch (err) {
      if (gen === this.generation) {
        this.log('feed_error', `connect failed: ${err instanceof Error ? err.message : String(err)}`);
        this.conn = null;
        this.schedule(true);
      }
    } finally {
      if (gen === this.generation) this.connecting = false;
    }
  }

  private onMessage(gen: number, data: string): void {
    if (gen !== this.generation || !this.conn) return;
    const now = this.now();
    this.lastMessageAt = now;
    this.counters.messages++;
    if (this.quickDrops && now - this.openedAt >= HEALTHY_AFTER_MS) this.quickDrops = 0;
    const ev = parseFeedMessage(data);
    if (ev.type === 'ticker') this.onTicker(ev.symbol, ev.price, ev.timestampMs);
    else if (ev.type === 'error') this.log('feed_error', ev.message);
  }

  /** The connection is gone (closed, silent or broken): forget it and plan the reconnect. */
  private lost(quick: boolean): void {
    this.counters.drops++;
    this.drop();
    this.markDown();
    this.schedule(quick);
  }

  private schedule(quick: boolean): void {
    this.quickDrops = quick ? this.quickDrops + 1 : 0;
    const delay = DELAYS_MS[Math.min(this.quickDrops, DELAYS_MS.length - 1)]!;
    this.nextConnectAt = this.now() + delay;
    this.markDown();
    this.wake(this.nextConnectAt);
  }

  private drop(): void {
    const conn = this.conn;
    this.conn = null;
    this.generation++;
    this.connecting = false;
    this.subscribed = new Set();
    if (conn) {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  }

  private markDown(): void {
    if (this.downSince === null && this.wanted.size) this.downSince = this.now();
  }

  private endDowntime(): void {
    if (this.downSince !== null) this.counters.downMs += this.now() - this.downSince;
    this.downSince = null;
  }
}
