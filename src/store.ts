/**
 * store.ts - SQLite persistence via node:sqlite (Node 24 built-in).
 *
 *   orders   one row per order, with the latest totals from the wallet.
 *   credits  an append-only audit log of every transfer ever seen for an
 *            order's subaddress. Never used to decide an order's status.
 *
 * Amounts are TEXT piconero (1 XMR = 10^12). Sums are done in TypeScript
 * with BigInt, never in SQL (SQLite integers overflow past 2^53 here).
 */

import { DatabaseSync } from "node:sqlite";

export type OrderStatus = "pending" | "seen" | "paid" | "expired";

export interface OrderRow {
  id: string;
  amount_atomic: string;
  /** The "minor" subaddress index under account 0. */
  subaddr_minor: number;
  address: string;
  status: OrderStatus;
  created_at: number;
  paid_at: number | null;
  /** 1 if a payment arrived after the order had expired. */
  late: number;
  /** Everything the wallet currently shows (confirmed + pool), piconero. */
  received_atomic: string;
  /** Part of that with enough confirmations, piconero. */
  confirmed_atomic: string;
  /** Fewest confirmations among the counted transfers (0 if none). */
  min_confirmations: number;
}

export interface OrderUpdate {
  status: OrderStatus;
  late: boolean;
  receivedAtomic: bigint;
  confirmedAtomic: bigint;
  minConfirmations: number;
}

export interface AuditEntry {
  txid: string;
  subaddrIndex: number;
  amountAtomic: bigint;
  height: number;
  confirmations: number;
  doubleSpendSeen: boolean;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id                TEXT PRIMARY KEY,
        amount_atomic     TEXT NOT NULL,
        subaddr_minor     INTEGER NOT NULL UNIQUE,
        address           TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('pending','seen','paid','expired')),
        created_at        INTEGER NOT NULL,
        paid_at           INTEGER,
        late              INTEGER NOT NULL DEFAULT 0,
        received_atomic   TEXT NOT NULL DEFAULT '0',
        confirmed_atomic  TEXT NOT NULL DEFAULT '0',
        min_confirmations INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS credits (
        txid              TEXT NOT NULL,
        subaddr_minor     INTEGER NOT NULL,
        amount_atomic     TEXT NOT NULL,
        height            INTEGER NOT NULL,
        confirmations     INTEGER NOT NULL,
        double_spend_seen INTEGER NOT NULL,
        PRIMARY KEY (txid, subaddr_minor)
      );
    `);
  }

  insertOrder(order: { id: string; amountAtomic: bigint; subaddrIndex: number; address: string }): void {
    this.db
      .prepare(
        `INSERT INTO orders (id, amount_atomic, subaddr_minor, address, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(order.id, order.amountAtomic.toString(), order.subaddrIndex, order.address, Date.now());
  }

  getOrder(id: string): OrderRow | undefined {
    return this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
  }

  /**
   * Orders worth polling: pending or seen, plus expired orders still inside
   * the late-payment window (created_at > expiredCutoff).
   */
  getPollableOrders(expiredCutoff: number): OrderRow[] {
    return this.db
      .prepare(
        `SELECT * FROM orders
         WHERE status IN ('pending','seen')
            OR (status = 'expired' AND created_at > ?)`
      )
      .all(expiredCutoff) as OrderRow[];
  }

  /**
   * Apply a poll result. A 'paid' order is never touched again, and paid_at
   * is written once. `late` only ever goes from 0 to 1.
   */
  updateOrder(id: string, u: OrderUpdate, now: number): void {
    this.db
      .prepare(
        `UPDATE orders SET
           status = ?,
           late = MAX(late, ?),
           received_atomic = ?,
           confirmed_atomic = ?,
           min_confirmations = ?,
           paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, ?) ELSE paid_at END
         WHERE id = ? AND status != 'paid'`
      )
      .run(
        u.status,
        u.late ? 1 : 0,
        u.receivedAtomic.toString(),
        u.confirmedAtomic.toString(),
        u.minConfirmations,
        u.status,
        now,
        id
      );
  }

  /** Audit log: insert once per (txid, subaddress); refresh the mutable fields. */
  logTransfer(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO credits (txid, subaddr_minor, amount_atomic, height, confirmations, double_spend_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (txid, subaddr_minor) DO UPDATE SET
           height = excluded.height,
           confirmations = excluded.confirmations,
           double_spend_seen = excluded.double_spend_seen`
      )
      .run(e.txid, e.subaddrIndex, e.amountAtomic.toString(), e.height, e.confirmations, e.doubleSpendSeen ? 1 : 0);
  }

  /** Number of logged transfers for this subaddress that the wallet flagged as double spends. */
  flaggedCount(subaddrIndex: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM credits WHERE subaddr_minor = ? AND double_spend_seen = 1`)
      .get(subaddrIndex) as { n: number | bigint };
    return Number(row.n);
  }

  /** All audit rows for a subaddress. */
  auditLog(subaddrIndex: number): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM credits WHERE subaddr_minor = ?`).all(subaddrIndex);
  }

  close(): void {
    this.db.close();
  }
}
