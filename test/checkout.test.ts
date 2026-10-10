/**
 * checkout.test.ts - order lifecycle against a fake wallet-rpc whose
 * get_transfers fixture is the docs' own example response, then varied.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { Store } from "../src/store.ts";
import { Checkout, xmrToAtomic, validateOrderId } from "../src/checkout.ts";
import { WalletRpcClient, WalletRpcError, parseWalletJson } from "../src/walletRpc.ts";
import { docsEntry, startFakeWalletRpc, type FakeWallet, type TransferJson } from "./fakeWalletRpc.ts";

const REQUIRED = 10;
const TTL_MINUTES = 60;
const LATE_DAYS = 7;

let wallet: FakeWallet;
let store: Store;
let checkout: Checkout;

beforeEach(async () => {
  wallet = await startFakeWalletRpc();
  store = new Store(":memory:");
  checkout = new Checkout(store, new WalletRpcClient(wallet.url), {
    requiredConfirmations: REQUIRED,
    orderTtlMinutes: TTL_MINUTES,
    latePaymentDays: LATE_DAYS,
  });
});

afterEach(async () => {
  store.close();
  await wallet.close();
});

let txCounter = 0;

/** The docs' example entry, moved to account 0 and the given subaddress. */
function transfer(minor: number, overrides: Record<string, unknown> = {}): TransferJson {
  return {
    ...docsEntry,
    subaddr_index: { major: 0, minor },
    subaddr_indices: [{ major: 0, minor }],
    txid: `tx${++txCounter}`.padEnd(64, "0"),
    amount: 500_000_000_000n,
    amounts: [500_000_000_000n],
    confirmations: REQUIRED,
    height: 100,
    ...overrides,
  };
}

/** Create an order and return its subaddress minor index. */
async function newOrder(id: string, amountXmr: string): Promise<number> {
  await checkout.createOrder(id, amountXmr);
  return store.getOrder(id)!.subaddr_minor;
}

/** Pretend the order was created `minutes` ago. */
function age(id: string, minutes: number): void {
  store.db.prepare(`UPDATE orders SET created_at = created_at - ? WHERE id = ?`).run(minutes * 60_000, id);
}

const status = (id: string) => store.getOrder(id)!.status;

// Amount parsing and ids

test("xmrToAtomic converts decimals exactly", () => {
  assert.equal(xmrToAtomic("0.000000000001"), 1n);
  assert.equal(xmrToAtomic("1"), 1_000_000_000_000n);
  assert.equal(xmrToAtomic("18446744.073709551615"), 18446744073709551615n);
});

test("xmrToAtomic rejects bad input", () => {
  assert.throws(() => xmrToAtomic("-1"), /must be a positive decimal/);
  assert.throws(() => xmrToAtomic("1e3"), /must be a positive decimal/);
  assert.throws(() => xmrToAtomic("0.1234567890123"), /maximum 12 decimal places/);
  assert.throws(() => xmrToAtomic("0"), /must be positive/);
  assert.throws(() => xmrToAtomic(""), /non-empty string/);
  assert.throws(() => xmrToAtomic("abc"), /must be a positive decimal/);
});

test("validateOrderId", () => {
  assert.doesNotThrow(() => validateOrderId("order-123_ABC.xyz"));
  for (const bad of ["", "a".repeat(65), "order 123", "../etc/passwd"]) {
    assert.throws(() => validateOrderId(bad), /Invalid order id/);
  }
});

// Precision

test("parseWalletJson keeps 2^64-1 exact in amount and amounts", () => {
  const raw = '{"result":{"in":[{"amount":18446744073709551615,"amounts":[18446744073709551615],"height":7}]}}';
  const entry = (parseWalletJson(raw) as { result: { in: Array<Record<string, unknown>> } }).result.in[0]!;
  assert.equal(entry["amount"], 18446744073709551615n);
  assert.deepEqual(entry["amounts"], [18446744073709551615n]);
  assert.equal(entry["height"], 7); // other numbers stay plain numbers
  assert.notEqual(BigInt(JSON.parse(raw).result.in[0].amount), 18446744073709551615n); // plain JSON.parse loses it
});

test("an order for 2^64-1 piconero is paid exactly, end to end", async () => {
  const minor = await newOrder("big", "18446744.073709551615");
  wallet.state.in.push(transfer(minor, { amount: 18446744073709551615n, amounts: [18446744073709551615n] }));
  await checkout.pollOnce();
  const view = checkout.view("big")!;
  assert.equal(view.status, "paid");
  assert.equal(view.received_atomic, "18446744073709551615");
  assert.equal(view.confirmed_atomic, "18446744073709551615");
});

// Orders

test("createOrder gives each order its own subaddress; duplicates are refused", async () => {
  const a = await checkout.createOrder("order-1", "0.5");
  const b = await checkout.createOrder("order-2", "0.5");
  assert.notEqual(a.address, b.address);
  assert.equal(a.status, "pending");
  await assert.rejects(() => checkout.createOrder("order-1", "0.5"), /already exists/);
});

test("concurrent createOrder with the same id uses one subaddress", async () => {
  const results = await Promise.allSettled([checkout.createOrder("x", "1"), checkout.createOrder("x", "1")]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(wallet.state.calls.filter((c) => c === "create_address").length, 1);
});

// Polling with docs-shaped data

test("docs-shaped payment: seen with 1 confirmation, paid at the required count", async () => {
  const minor = await newOrder("o1", "0.2");
  // The docs' example entry, only moved to account 0 and this subaddress.
  wallet.state.in.push({ ...docsEntry, subaddr_index: { major: 0, minor } });
  await checkout.pollOnce();
  let view = checkout.view("o1")!;
  assert.equal(view.status, "seen");
  assert.equal(view.received_atomic, "200000000000");
  assert.equal(view.confirmed_atomic, "0");
  assert.equal(view.confirmations, 1);

  wallet.state.in[0] = { ...wallet.state.in[0]!, confirmations: REQUIRED };
  await checkout.pollOnce();
  view = checkout.view("o1")!;
  assert.equal(view.status, "paid");
  assert.equal(view.confirmed_atomic, "200000000000");
  assert.equal(view.confirmations, REQUIRED);
  assert.ok(view.paid_at !== null);
});

test("transfers from another account (major != 0) are ignored", async () => {
  const minor = await newOrder("o1", "0.2");
  // Literally the docs' example: major 1. Point it at our minor index.
  wallet.state.in.push({ ...docsEntry, subaddr_index: { major: 1, minor }, confirmations: REQUIRED });
  await checkout.pollOnce();
  assert.equal(status("o1"), "pending");
  assert.equal(checkout.view("o1")!.received_atomic, "0");
});

test("a pool tx is 'seen'; a pool double spend is ignored and flagged", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.pool.push(transfer(minor, { confirmations: 0, height: 0, double_spend_seen: true }));
  await checkout.pollOnce();
  let view = checkout.view("o1")!;
  assert.equal(view.status, "pending");
  assert.equal(view.received_atomic, "0");
  assert.equal(view.double_spend_flagged, 1);

  wallet.state.pool.push(transfer(minor, { confirmations: 0, height: 0 }));
  await checkout.pollOnce();
  view = checkout.view("o1")!;
  assert.equal(view.status, "seen");
  assert.equal(view.received_atomic, "500000000000");
});

test("a pool entry WITHOUT a confirmations field (as real wallet-rpc sends it) is seen at 0 confirmations", async () => {
  // Real monero-wallet-rpc v0.18.5.3 omits "confirmations" from "pool" entries
  // (they carry type "pool", height 0 and no confirmations key at all).
  const minor = await newOrder("o1", "0.5");
  const entry = transfer(minor, { height: 0, type: "pool" });
  delete entry.confirmations;
  wallet.state.pool.push(entry);

  assert.equal(await checkout.pollOnce(), true);
  const view = checkout.view("o1")!;
  assert.equal(view.status, "seen");
  assert.equal(view.received_atomic, "500000000000");
  assert.equal(view.confirmed_atomic, "0");
  assert.equal(view.confirmations, 0);
  assert.equal(store.auditLog(minor).length, 1);
  assert.equal(store.auditLog(minor)[0]!["confirmations"], 0);
});

test("a confirmed double spend never pays an order", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(transfer(minor, { double_spend_seen: true }));
  await checkout.pollOnce();
  assert.equal(status("o1"), "pending");
});

test("a dropped pool tx returns the order to pending, then normal expiry applies", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.pool.push(transfer(minor, { confirmations: 0, height: 0 }));
  await checkout.pollOnce();
  assert.equal(status("o1"), "seen");

  wallet.state.pool.length = 0;
  await checkout.pollOnce();
  assert.equal(status("o1"), "pending");
  assert.equal(checkout.view("o1")!.received_atomic, "0");

  age("o1", TTL_MINUTES + 1);
  await checkout.pollOnce();
  assert.equal(status("o1"), "expired");
});

test("a reorg: an entry that disappears from 'in' is no longer counted", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(transfer(minor, { confirmations: 3 }));
  await checkout.pollOnce();
  assert.equal(checkout.view("o1")!.received_atomic, "500000000000");

  wallet.state.in.length = 0;
  await checkout.pollOnce();
  assert.equal(status("o1"), "pending");
  assert.equal(checkout.view("o1")!.received_atomic, "0");
});

test("once paid, always paid, and paid_at is written once", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(transfer(minor));
  await checkout.pollOnce();
  const paidAt = store.getOrder("o1")!.paid_at;
  assert.equal(status("o1"), "paid");

  wallet.state.in.length = 0; // reorged away afterwards
  await checkout.pollOnce();
  assert.equal(status("o1"), "paid");
  assert.equal(store.getOrder("o1")!.paid_at, paidAt);
});

test("underpayment stays 'seen' with the received total; overpayment is 'paid'", async () => {
  const minor = await newOrder("under", "0.5");
  wallet.state.in.push(transfer(minor, { amount: 100_000_000_000n }));
  const minor2 = await newOrder("over", "0.5");
  wallet.state.in.push(transfer(minor2, { amount: 600_000_000_000n }));
  await checkout.pollOnce();
  assert.equal(status("under"), "seen");
  assert.equal(checkout.view("under")!.received_atomic, "100000000000");
  assert.equal(status("over"), "paid");
  assert.equal(checkout.view("over")!.received_atomic, "600000000000");
});

test("two transfers that sum to the amount pay the order", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(transfer(minor, { amount: 200_000_000_000n }), transfer(minor, { amount: 300_000_000_000n }));
  await checkout.pollOnce();
  assert.equal(status("o1"), "paid");
});

test("confirmed_atomic counts only transfers with enough confirmations", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(
    transfer(minor, { amount: 200_000_000_000n, confirmations: REQUIRED }),
    transfer(minor, { amount: 300_000_000_000n, confirmations: 2 })
  );
  await checkout.pollOnce();
  const view = checkout.view("o1")!;
  assert.equal(view.status, "seen");
  assert.equal(view.received_atomic, "500000000000");
  assert.equal(view.confirmed_atomic, "200000000000");
  assert.equal(view.confirmations, 2);
});

test("the audit log keeps one row per tx and refreshes confirmations", async () => {
  const minor = await newOrder("o1", "0.5");
  const tx = transfer(minor, { confirmations: 2 });
  wallet.state.in.push(tx);
  await checkout.pollOnce();
  wallet.state.in[0] = { ...tx, confirmations: 4, height: 101 };
  await checkout.pollOnce();
  const rows = store.auditLog(minor);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["confirmations"], 4);
  assert.equal(rows[0]!["height"], 101);
});

// Expiry and late payments

test("nothing seen after the TTL -> expired", async () => {
  await newOrder("o1", "0.5");
  age("o1", TTL_MINUTES + 1);
  await checkout.pollOnce();
  assert.equal(status("o1"), "expired");
});

test("a payment to an expired order is never ignored: it becomes paid with late = true", async () => {
  const minor = await newOrder("o1", "0.5");
  age("o1", TTL_MINUTES + 1);
  await checkout.pollOnce();
  assert.equal(status("o1"), "expired");

  wallet.state.in.push(transfer(minor));
  await checkout.pollOnce();
  const view = checkout.view("o1")!;
  assert.equal(view.status, "paid");
  assert.equal(view.late, true);
});

test("a late pool tx makes an expired order 'seen' with late = true", async () => {
  const minor = await newOrder("o1", "0.5");
  age("o1", TTL_MINUTES + 1);
  await checkout.pollOnce();
  wallet.state.pool.push(transfer(minor, { confirmations: 0, height: 0 }));
  await checkout.pollOnce();
  assert.equal(status("o1"), "seen");
  assert.equal(checkout.view("o1")!.late, true);
});

test("orders expired longer than LATE_PAYMENT_DAYS are no longer polled", async () => {
  const minor = await newOrder("o1", "0.5");
  age("o1", TTL_MINUTES + 1);
  await checkout.pollOnce();
  age("o1", LATE_DAYS * 24 * 60);
  wallet.state.in.push(transfer(minor));
  await checkout.pollOnce();
  assert.equal(status("o1"), "expired");
});

test("an on-time payment is not marked late", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(transfer(minor));
  await checkout.pollOnce();
  assert.equal(checkout.view("o1")!.late, false);
});

// Poller behaviour

test("an overlapping poll is skipped", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(transfer(minor));
  let release!: () => void;
  wallet.state.hold = new Promise<void>((resolve) => (release = resolve));

  const first = checkout.pollOnce();
  while (!wallet.state.calls.includes("get_transfers")) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await checkout.pollOnce(), false); // skipped, not queued

  release();
  assert.equal(await first, true);
  assert.equal(wallet.state.calls.filter((c) => c === "get_transfers").length, 1);
  assert.equal(status("o1"), "paid");
});

test("no pollable orders -> no wallet call", async () => {
  assert.equal(await checkout.pollOnce(), true);
  assert.deepEqual(wallet.state.calls, []);
});

test("a failed poll throws once and the next poll retries", async () => {
  const minor = await newOrder("o1", "0.5");
  wallet.state.in.push(transfer(minor));
  wallet.state.failHttp = true;
  await assert.rejects(() => checkout.pollOnce(), WalletRpcError);
  wallet.state.failHttp = false;
  assert.equal(await checkout.pollOnce(), true);
  assert.equal(status("o1"), "paid");
});

// Client

test("client: HTTP error and timeout become short WalletRpcErrors", async () => {
  wallet.state.failHttp = true;
  await assert.rejects(() => new WalletRpcClient(wallet.url).createAddress("a"), /HTTP 500/);
  wallet.state.failHttp = false;

  let release!: () => void;
  wallet.state.hold = new Promise<void>((resolve) => (release = resolve));
  await assert.rejects(() => new WalletRpcClient(wallet.url, 50).getTransfers([1]), /unreachable or timed out/);
  release();
});
