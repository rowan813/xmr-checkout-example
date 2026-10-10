/**
 * checkout.ts - order lifecycle: create, poll, pending/seen/paid/expired.
 *
 * Every poll recomputes an order's totals from the CURRENT get_transfers
 * response (confirmed "in" plus "pool", account 0, no double spends). The
 * credits table is only an audit log, so a reorg or a dropped pool tx can
 * never leave a stale credit behind.
 *
 *   paid     sum of transfers with confirmations >= REQUIRED_CONFIRMATIONS
 *            is >= the order amount. Once paid, always paid.
 *   seen     something is currently in the pool or the chain for the
 *            order's subaddress, but not enough confirmed yet.
 *   pending  nothing right now (also where a dropped pool tx goes back to).
 *   expired  TTL passed while pending. Still polled for LATE_PAYMENT_DAYS:
 *            a payment arriving then moves it to seen/paid with late = true.
 *
 * Assumption (the docs do not promise it): the wallet reports one entry per
 * transaction per subaddress, so (txid, minor index) identifies a transfer.
 */

import type { Store, OrderRow, OrderStatus } from "./store.ts";
import type { WalletRpcClient, Transfer } from "./walletRpc.ts";

export interface CheckoutConfig {
  requiredConfirmations: number;
  orderTtlMinutes: number;
  latePaymentDays: number;
}

export interface OrderView {
  id: string;
  address: string;
  amount_atomic: string;
  status: OrderStatus;
  /** Confirmed + pool, from the latest poll (excludes flagged double spends). */
  received_atomic: string;
  /** The part that has enough confirmations. */
  confirmed_atomic: string;
  /** Fewest confirmations among the counted transfers; 0 if none. */
  confirmations: number;
  /** True if a payment arrived after the order expired. */
  late: boolean;
  /** Transfers the wallet flagged double_spend_seen; never counted. */
  double_spend_flagged: number;
  created_at: number;
  paid_at: number | null;
}

/** Bad input from the caller (maps to HTTP 400). */
export class ValidationError extends Error {}
/** The order id is already taken (maps to HTTP 409). */
export class DuplicateOrderError extends Error {}

type Wallet = Pick<WalletRpcClient, "createAddress" | "getTransfers">;

export class Checkout {
  private readonly store: Store;
  private readonly wallet: Wallet;
  private readonly config: CheckoutConfig;
  private polling = false;
  private readonly creating = new Set<string>();

  constructor(store: Store, wallet: Wallet, config: CheckoutConfig) {
    this.store = store;
    this.wallet = wallet;
    this.config = config;
  }

  /** New order with a fresh subaddress labelled with the order id. */
  async createOrder(id: string, amountXmr: string): Promise<OrderView> {
    validateOrderId(id);
    const amountAtomic = xmrToAtomic(amountXmr);
    // Claim the id before the await so concurrent requests cannot burn a subaddress.
    if (this.creating.has(id) || this.store.getOrder(id)) {
      throw new DuplicateOrderError(`Order ${id} already exists`);
    }
    this.creating.add(id);
    try {
      const { address, address_index } = await this.wallet.createAddress(id);
      this.store.insertOrder({ id, amountAtomic, subaddrIndex: address_index, address });
    } finally {
      this.creating.delete(id);
    }
    return this.view(id)!;
  }

  view(id: string): OrderView | undefined {
    const order = this.store.getOrder(id);
    return order && this.toView(order);
  }

  /** One poll. Returns false (and does nothing) if a poll is already running. */
  async pollOnce(): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    try {
      await this.poll();
      return true;
    } finally {
      this.polling = false;
    }
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const ttlMs = this.config.orderTtlMinutes * 60_000;
    const lateMs = this.config.latePaymentDays * 86_400_000;
    const orders = this.store.getPollableOrders(now - ttlMs - lateMs);
    if (orders.length === 0) return;

    const result = await this.wallet.getTransfers(orders.map((o) => o.subaddr_minor));
    const byMinor = groupByMinor([...(result.in ?? []), ...(result.pool ?? [])]);
    for (const order of orders) {
      this.applyTransfers(order, byMinor.get(order.subaddr_minor) ?? [], now);
    }
  }

  private applyTransfers(order: OrderRow, transfers: Transfer[], now: number): void {
    for (const t of transfers) {
      this.store.logTransfer({
        txid: t.txid,
        subaddrIndex: order.subaddr_minor,
        amountAtomic: t.amount,
        height: t.height,
        confirmations: t.confirmations,
        doubleSpendSeen: t.double_spend_seen,
      });
    }

    const counted = transfers.filter((t) => !t.double_spend_seen);
    const received = sum(counted);
    const confirmed = sum(counted.filter((t) => t.confirmations >= this.config.requiredConfirmations));
    const minConfirmations = counted.length === 0 ? 0 : Math.min(...counted.map((t) => t.confirmations));

    const wasExpired = order.status === "expired";
    let status: OrderStatus;
    if (confirmed >= BigInt(order.amount_atomic)) {
      status = "paid";
    } else if (counted.length > 0) {
      status = "seen";
    } else if (wasExpired || now - order.created_at > this.config.orderTtlMinutes * 60_000) {
      status = "expired";
    } else {
      status = "pending";
    }

    this.store.updateOrder(
      order.id,
      {
        status,
        late: wasExpired && status !== "expired",
        receivedAtomic: received,
        confirmedAtomic: confirmed,
        minConfirmations,
      },
      now
    );
  }

  private toView(order: OrderRow): OrderView {
    return {
      id: order.id,
      address: order.address,
      amount_atomic: order.amount_atomic,
      status: order.status,
      received_atomic: order.received_atomic,
      confirmed_atomic: order.confirmed_atomic,
      confirmations: order.min_confirmations,
      late: order.late === 1,
      double_spend_flagged: this.store.flaggedCount(order.subaddr_minor),
      created_at: order.created_at,
      paid_at: order.paid_at,
    };
  }
}

function sum(transfers: Transfer[]): bigint {
  return transfers.reduce((total, t) => total + t.amount, 0n);
}

/** Group by the subaddress "minor" index, keeping only account 0 (major 0). */
function groupByMinor(transfers: Transfer[]): Map<number, Transfer[]> {
  const map = new Map<number, Transfer[]>();
  for (const t of transfers) {
    if (t.subaddr_index.major !== 0) continue;
    const list = map.get(t.subaddr_index.minor) ?? [];
    list.push(t);
    map.set(t.subaddr_index.minor, list);
  }
  return map;
}

// Validation

const ORDER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validateOrderId(id: string): void {
  if (!ORDER_ID_RE.test(id)) {
    throw new ValidationError(`Invalid order id "${id}": use 1-64 characters of [A-Za-z0-9._-]`);
  }
}

/**
 * Parse a decimal XMR amount (e.g. "0.5") into BigInt piconero.
 * No floats, no exponents, at most 12 decimal places, must be positive.
 */
export function xmrToAtomic(amountXmr: string): bigint {
  if (typeof amountXmr !== "string" || amountXmr.length === 0) {
    throw new ValidationError("amount_xmr must be a non-empty string");
  }
  if (!/^\d+(\.\d+)?$/.test(amountXmr)) {
    throw new ValidationError(`Invalid amount_xmr "${amountXmr}": must be a positive decimal number`);
  }
  const [whole, frac = ""] = amountXmr.split(".");
  if (frac.length > 12) {
    throw new ValidationError(`Invalid amount_xmr "${amountXmr}": maximum 12 decimal places`);
  }
  const atomic = BigInt(whole!) * 1_000_000_000_000n + BigInt(frac.padEnd(12, "0"));
  if (atomic <= 0n) {
    throw new ValidationError(`Invalid amount_xmr "${amountXmr}": must be positive`);
  }
  return atomic;
}
