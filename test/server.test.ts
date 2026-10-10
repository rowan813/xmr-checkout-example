/**
 * server.test.ts - the HTTP API on an ephemeral loopback port, in front of
 * the fake wallet-rpc.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Store } from "../src/store.ts";
import { Checkout } from "../src/checkout.ts";
import { createApp, MAX_BODY_BYTES } from "../src/server.ts";
import { WalletRpcClient } from "../src/walletRpc.ts";
import { startFakeWalletRpc, type FakeWallet } from "./fakeWalletRpc.ts";

let wallet: FakeWallet;
let store: Store;
let server: Server;
let base: string;

beforeEach(async () => {
  wallet = await startFakeWalletRpc();
  store = new Store(":memory:");
  const checkout = new Checkout(store, new WalletRpcClient(wallet.url), {
    requiredConfirmations: 10,
    orderTtlMinutes: 60,
    latePaymentDays: 7,
  });
  server = createApp(checkout);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await wallet.close();
});

const post = (body: string) =>
  fetch(`${base}/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

test("POST /orders creates an order; GET /orders/:id returns the view", async () => {
  const created = await post(JSON.stringify({ id: "order-1", amount_xmr: "0.5" }));
  assert.equal(created.status, 201);
  const body = (await created.json()) as Record<string, unknown>;
  assert.equal(body["id"], "order-1");
  assert.equal(body["status"], "pending");
  assert.equal(body["amount_xmr"], "0.5");

  const got = await fetch(`${base}/orders/order-1`);
  assert.equal(got.status, 200);
  const view = (await got.json()) as Record<string, unknown>;
  assert.equal(view["amount_atomic"], "500000000000");
  assert.equal(view["received_atomic"], "0");
  assert.equal(view["confirmed_atomic"], "0");
  assert.equal(view["confirmations"], 0);
  assert.equal(view["late"], false);
});

test("400 for invalid JSON, null, wrong types, bad id and bad amount", async () => {
  for (const bad of [
    "{not json",
    "null",
    "[]",
    "42",
    JSON.stringify({ id: 5, amount_xmr: "1" }),
    JSON.stringify({ id: "a" }),
    JSON.stringify({ id: "bad id!", amount_xmr: "1" }),
    JSON.stringify({ id: "a", amount_xmr: "-1" }),
  ]) {
    assert.equal((await post(bad)).status, 400, bad);
  }
  assert.deepEqual(wallet.state.calls, []); // nothing reached the wallet
});

test("400 for malformed URL encoding", async () => {
  assert.equal((await fetch(`${base}/orders/%E0%A4%A`)).status, 400);
});

test("404 for an unknown order and an unknown route", async () => {
  assert.equal((await fetch(`${base}/orders/nope`)).status, 404);
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
});

test("409 for a duplicate id", async () => {
  const body = JSON.stringify({ id: "dup", amount_xmr: "1" });
  assert.equal((await post(body)).status, 201);
  assert.equal((await post(body)).status, 409);
});

test("413 for a body over the 1 MB limit", async () => {
  const res = await post(JSON.stringify({ id: "a", amount_xmr: "1", pad: "x".repeat(MAX_BODY_BYTES) }));
  assert.equal(res.status, 413);
});

test("502 with a short message when wallet-rpc errors", async () => {
  wallet.state.failHttp = true;
  const res = await post(JSON.stringify({ id: "o", amount_xmr: "1" }));
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /wallet-rpc HTTP 500/);
});

test("502 when wallet-rpc is unreachable", async () => {
  await wallet.close();
  const res = await post(JSON.stringify({ id: "o", amount_xmr: "1" }));
  assert.equal(res.status, 502);
  wallet = await startFakeWalletRpc(); // so afterEach can close something
});
