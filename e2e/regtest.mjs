#!/usr/bin/env node
/**
 * e2e/regtest.mjs - end-to-end test of the checkout server against REAL
 * monerod + monero-wallet-rpc on a private regtest chain.
 *
 *   MONERO_BIN_DIR=/path/to/monero-bin node e2e/regtest.mjs
 *   (or: node e2e/regtest.mjs /path/to/monero-bin)
 *
 * Optional env: REGTEST_RUN_DIR (default <MONERO_BIN_DIR>/../run),
 *               E2E_LARGE=1 (also try the >2^53 piconero scenario; slow).
 *
 * Plain Node, no dependencies. Everything binds to 127.0.0.1. Regtest coins
 * are worthless and every wallet here is a throwaway. Every process started
 * is recorded and stopped at the end.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- config ----------

const binDir = path.resolve(process.argv[2] ?? process.env.MONERO_BIN_DIR ?? "");
if (!process.argv[2] && !process.env.MONERO_BIN_DIR) {
  console.error("Usage: MONERO_BIN_DIR=/path/to/monero-bin node e2e/regtest.mjs");
  process.exit(2);
}
for (const b of ["monerod", "monero-wallet-rpc"]) {
  if (!existsSync(path.join(binDir, b))) {
    console.error(`${b} not found in ${binDir}`);
    process.exit(2);
  }
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runDir = path.resolve(process.env.REGTEST_RUN_DIR ?? path.join(binDir, "..", "run"));
const MARKER = ".xmr-e2e-run-dir";

const P = {
  daemonRpc: 28881,
  daemonP2p: 28880,
  merchantWallet: 38083, // the repo's default WALLET_RPC_URL port
  senderWallet: 38084,
  checkout: 38090,
  checkoutTtl: 38091,
};
const HOST = "127.0.0.1";
const CONFIRMATIONS = 3;
const POLL_SECONDS = 2;
const PW = "e2e-throwaway";
const SETUP_BLOCKS = 130;
const ONLY = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(",") : null; // e.g. E2E_ONLY=1,6 (debugging)
const want = (n) => !ONLY || ONLY.includes(String(n));

// ---------- output / checks ----------

const results = []; // {scenario, check, ok, detail}
let currentScenario = "setup";
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const log = (...a) => console.log(stamp(), ...a);
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function check(name, ok, detail = "") {
  results.push({ scenario: currentScenario, check: name, ok: !!ok, detail });
  console.log(`${stamp()} ${ok ? "PASS" : "FAIL"} [${currentScenario}] ${name}${detail ? " :: " + detail : ""}`);
  return !!ok;
}
function note(...a) {
  console.log(`${stamp()}      note [${currentScenario}]`, ...a);
}
function scenario(name) {
  currentScenario = name;
  console.log(`\n${stamp()} ===== ${name} =====`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs = 60_000, everyMs = 500) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = undefined;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout (${timeoutMs} ms) waiting for: ${desc}`);
}

// ---------- processes ----------

const procs = []; // {name, pid, child}

function startProc(name, cmd, args, env = {}, cwd = runDir) {
  const out = openSync(path.join(runDir, `${name}.out`), "a");
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  const rec = { name, pid: child.pid, child, exited: false };
  child.on("exit", () => (rec.exited = true));
  procs.push(rec);
  writeFileSync(
    path.join(runDir, "pids.json"),
    JSON.stringify(procs.map((p) => ({ name: p.name, pid: p.pid })), null, 2)
  );
  log(`started ${name} pid=${child.pid}`);
  return rec;
}

async function stopProc(rec) {
  if (rec.exited) return;
  rec.child.kill("SIGTERM");
  const start = Date.now();
  while (!rec.exited && Date.now() - start < 20_000) await sleep(200);
  if (!rec.exited) {
    log(`${rec.name} pid=${rec.pid} ignored SIGTERM for 20s, sending SIGKILL`);
    rec.child.kill("SIGKILL");
    await sleep(500);
  }
  log(`stopped ${rec.name} pid=${rec.pid} (exited=${rec.exited})`);
}

async function stopAll() {
  for (const rec of [...procs].reverse()) await stopProc(rec);
}

// ---------- RPC helpers ----------

async function jsonRpc(port, method, params = {}, timeoutMs = 110_000) {
  const res = await fetch(`http://${HOST}:${port}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}
async function must(port, method, params, timeoutMs) {
  const { json } = await jsonRpc(port, method, params, timeoutMs);
  if (json.error) throw new Error(`${method} failed: ${show(json.error)}`);
  return json.result;
}
const dRpc = (m, p, t) => must(P.daemonRpc, m, p, t);
const sRpc = (m, p, t) => must(P.senderWallet, m, p, t);
const mRpc = (m, p, t) => must(P.merchantWallet, m, p, t);

async function daemonPost(uri, body = {}) {
  const res = await fetch(`http://${HOST}:${P.daemonRpc}${uri}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(110_000),
  });
  return res.json();
}

const height = async () => (await dRpc("get_info")).height;
let senderAddress;
async function mine(n, address = senderAddress) {
  // Batches keep each call short.
  let left = n;
  while (left > 0) {
    const k = Math.min(left, 50);
    await dRpc("generateblocks", { wallet_address: address, amount_of_blocks: k, reserve_size: 20, prev_block: "", starting_nonce: 0 });
    left -= k;
  }
}
async function poolSize() {
  const r = await daemonPost("/get_transaction_pool_stats");
  return r.pool_stats?.txs_total ?? -1;
}

const xmr = (s) => BigInt(Math.round(Number(s) * 1e6)) * 1_000_000n; // test amounts only, <= 6 decimals

async function pay(address, amountXmr) {
  const atomic = xmr(amountXmr);
  await sRpc("refresh", {});
  const r = await sRpc("transfer", {
    destinations: [{ amount: Number(atomic), address }],
    account_index: 0,
    priority: 0,
    ring_size: 16,
    get_tx_key: false,
  }, 110_000);
  note(`sender paid ${amountXmr} XMR (${atomic} atomic) -> ${address.slice(0, 12)}... tx=${r.tx_hash.slice(0, 16)}...`);
  return r.tx_hash;
}

// ---------- checkout server helpers ----------

function startCheckout(name, port, dbPath, ttlMinutes) {
  return startProc(
    name,
    process.execPath,
    ["src/main.ts"],
    {
      WALLET_RPC_URL: `http://${HOST}:${P.merchantWallet}/json_rpc`,
      DB_PATH: dbPath,
      REQUIRED_CONFIRMATIONS: String(CONFIRMATIONS),
      POLL_SECONDS: String(POLL_SECONDS),
      ORDER_TTL_MINUTES: String(ttlMinutes),
      HOST,
      PORT: String(port),
    },
    repoRoot
  );
}
async function waitCheckout(port) {
  await waitFor(`checkout on ${port}`, async () => (await fetch(`http://${HOST}:${port}/orders/none`)).status === 404, 30_000, 300);
}
async function http(port, method, urlPath, body) {
  const res = await fetch(`http://${HOST}:${port}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const createOrder = (port, id, amt) => http(port, "POST", "/orders", { id, amount_xmr: amt });
const getOrder = async (port, id) => (await http(port, "GET", `/orders/${id}`)).json;

/** Wait until the order view satisfies pred; returns the view. */
async function waitOrder(port, id, desc, pred, timeoutMs = 45_000) {
  let last;
  try {
    return await waitFor(`${id}: ${desc}`, async () => {
      last = await getOrder(port, id);
      return pred(last) ? last : null;
    }, timeoutMs, 500);
  } catch (e) {
    note(`${e.message}; last view = ${show(last)}`);
    return last ?? {};
  }
}
const brief = (v) => `status=${v.status} received=${v.received_atomic} confirmed=${v.confirmed_atomic} conf=${v.confirmations} late=${v.late} paid_at=${v.paid_at}`;

function creditsRows(dbPath, minor) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const q = minor === undefined ? "SELECT * FROM credits ORDER BY subaddr_minor, txid" : "SELECT * FROM credits WHERE subaddr_minor = ? ORDER BY txid";
    return (minor === undefined ? db.prepare(q).all() : db.prepare(q).all(minor)).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}
function orderRowMinor(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("SELECT subaddr_minor FROM orders WHERE id = ?").get(id)?.subaddr_minor; } finally { db.close(); }
}

// ---------- main ----------

const raw = { createAddress: null, getTransfersIn: null, getTransfersPool: null };
let exitCode = 0;

async function main() {
  // --- prepare run dir (only ever deletes a dir this script marked itself) ---
  if (existsSync(runDir)) {
    if (!existsSync(path.join(runDir, MARKER))) throw new Error(`${runDir} exists and is not an e2e run dir (no ${MARKER}); refusing to delete it`);
    rmSync(runDir, { recursive: true, force: true });
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, MARKER), "created by e2e/regtest.mjs\n");
  for (const d of ["daemon", "wallets-sender", "wallets-merchant"]) mkdirSync(path.join(runDir, d));
  const emptyConf = path.join(runDir, "empty.conf");
  // An empty config file stops monerod/wallet-rpc from reading ~/.bitmonero/bitmonero.conf
  // (a user's own config can set restricted-rpc, which hides generateblocks etc.).
  writeFileSync(emptyConf, "");
  log(`run dir ${runDir}; bin dir ${binDir}`);

  // --- processes ---
  scenario("setup");
  startProc("monerod", path.join(binDir, "monerod"), [
    "--config-file", emptyConf, "--regtest", "--offline", "--fixed-difficulty", "1",
    "--data-dir", path.join(runDir, "daemon"),
    "--p2p-bind-ip", HOST, "--p2p-bind-port", String(P.daemonP2p),
    "--rpc-bind-ip", HOST, "--rpc-bind-port", String(P.daemonRpc),
    "--no-zmq", "--non-interactive", "--disable-dns-checkpoints", "--check-updates", "disabled",
    "--rpc-ssl", "disabled", "--no-igd", "--log-level", "1",
    "--log-file", path.join(runDir, "monerod.log"),
  ]);
  await waitFor("monerod rpc", async () => (await jsonRpc(P.daemonRpc, "get_version")).json.result, 60_000, 500);
  const info = await dRpc("get_info");
  check("daemon is regtest (fakechain), offline, unrestricted", info.nettype === "fakechain" && info.offline === true && info.restricted === false,
    `nettype=${info.nettype} offline=${info.offline} restricted=${info.restricted}`);

  const walletArgs = (dir, port, logName) => [
    "--config-file", emptyConf, "--wallet-dir", path.join(runDir, dir),
    "--rpc-bind-ip", HOST, "--rpc-bind-port", String(port), "--disable-rpc-login",
    "--daemon-address", `${HOST}:${P.daemonRpc}`, "--rpc-ssl", "disabled", "--daemon-ssl", "disabled",
    "--allow-mismatched-daemon-version", "--log-level", "1",
    // keep the shared ring database out of ~/.shared-ringdb (it would otherwise record regtest rings there)
    "--shared-ringdb-dir", path.join(runDir, "ringdb-" + dir), "--log-file", path.join(runDir, `${logName}.log`),
  ];
  startProc("wallet-rpc-sender", path.join(binDir, "monero-wallet-rpc"), walletArgs("wallets-sender", P.senderWallet, "wallet-sender"));
  startProc("wallet-rpc-merchant", path.join(binDir, "monero-wallet-rpc"), walletArgs("wallets-merchant", P.merchantWallet, "wallet-merchant"));
  await waitFor("wallet-rpc sender", async () => (await jsonRpc(P.senderWallet, "get_version")).json.result, 60_000);
  await waitFor("wallet-rpc merchant", async () => (await jsonRpc(P.merchantWallet, "get_version")).json.result, 60_000);

  // --- sender: full wallet, funded by mining ---
  await sRpc("create_wallet", { filename: "sender", password: PW, language: "English" });
  senderAddress = (await sRpc("get_address", { account_index: 0 })).address;
  note(`sender primary address ${senderAddress.slice(0, 10)}... (mainnet-format: starts with ${senderAddress[0]}, length ${senderAddress.length})`);
  check("regtest uses mainnet-format addresses (95 chars, leading 4)", senderAddress.length === 95 && senderAddress[0] === "4", `first=${senderAddress[0]} len=${senderAddress.length}`);

  const mineStart = Date.now();
  await mine(SETUP_BLOCKS);
  log(`mined ${SETUP_BLOCKS} blocks in ${((Date.now() - mineStart) / 1000).toFixed(1)}s; height=${await height()}`);
  await sRpc("refresh", {}, 110_000);
  const bal = await sRpc("get_balance", { account_index: 0 });
  check("sender has unlocked funds after the setup blocks (coinbase unlocks after 60)", bal.unlocked_balance > 0 && bal.unlocked_balance < bal.balance,
    `balance=${bal.balance} unlocked=${bal.unlocked_balance}`);

  // --- merchant: full wallet -> keys -> view-only wallet ---
  await mRpc("create_wallet", { filename: "merchant-full", password: PW, language: "English" });
  const merchantAddress = (await mRpc("get_address", { account_index: 0 })).address;
  const viewKey = (await mRpc("query_key", { key_type: "view_key" })).key;
  await mRpc("close_wallet", {});
  const gfk = await jsonRpc(P.merchantWallet, "generate_from_keys", {
    address: merchantAddress, viewkey: viewKey, filename: "checkout-view", password: PW, restore_height: 0,
  });
  note(`generate_from_keys -> ${gfk.text.replace(/\s+/g, " ")}`);
  check("generate_from_keys (no spendkey) succeeds", !gfk.json.error, show(gfk.json.error ?? gfk.json.result));

  const sk = await jsonRpc(P.merchantWallet, "query_key", { key_type: "spend_key" });
  note(`query_key spend_key on view-only wallet -> ${sk.text.replace(/\s+/g, " ")}`);
  const skOk = !!sk.json.error || /^0+$/.test(sk.json.result?.key ?? "x");
  check("view-only wallet exposes no spend key", skOk, sk.json.error ? `error ${show(sk.json.error)}` : `key=${sk.json.result?.key}`);
  const mn = await jsonRpc(P.merchantWallet, "query_key", { key_type: "mnemonic" });
  note(`query_key mnemonic on view-only wallet -> ${mn.text.replace(/\s+/g, " ").slice(0, 160)}`);
  const vk = await jsonRpc(P.merchantWallet, "query_key", { key_type: "view_key" });
  check("view key is readable and matches", vk.json.result?.key === viewKey);
  const tryXfer = await jsonRpc(P.merchantWallet, "transfer", { destinations: [{ amount: 1, address: senderAddress }] });
  check("transfer on the view-only wallet is refused", !!tryXfer.json.error, show(tryXfer.json.error ?? tryXfer.json.result));

  // README step 3 note: is open_wallet needed after generate_from_keys?
  const ca = await jsonRpc(P.merchantWallet, "create_address", { account_index: 0, label: "probe-no-open" });
  raw.createAddress = ca.text;
  let openWalletNeeded;
  if (ca.json.error) {
    openWalletNeeded = true;
    note(`create_address right after generate_from_keys FAILED: ${show(ca.json.error)}; calling open_wallet`);
    await mRpc("open_wallet", { filename: "checkout-view", password: PW });
  } else {
    openWalletNeeded = false;
    note(`create_address right after generate_from_keys WORKED without open_wallet: ${ca.text.replace(/\s+/g, " ")}`);
  }
  check("README step 3: open_wallet needed after generate_from_keys?", true, `open_wallet needed = ${openWalletNeeded}`);

  // Wallet refresh cadence: real wallet-rpc only refreshes on a timer.
  const ar = await jsonRpc(P.merchantWallet, "auto_refresh", { enable: true, period: 1 });
  note(`auto_refresh(period 1) merchant -> ${ar.text.replace(/\s+/g, " ")}`);
  await jsonRpc(P.senderWallet, "auto_refresh", { enable: true, period: 1 });
  await mRpc("refresh", {}, 110_000);
  const mbal = await mRpc("get_balance", { account_index: 0 });
  note(`merchant wallet balance ${show(mbal)}`);

  // --- checkout servers ---
  const mainDb = path.join(runDir, "checkout-main.db");
  const ttlDb = path.join(runDir, "checkout-ttl.db");
  let main = startCheckout("checkout-main", P.checkout, mainDb, 60);
  startCheckout("checkout-ttl1", P.checkoutTtl, ttlDb, 1);
  await waitCheckout(P.checkout);
  await waitCheckout(P.checkoutTtl);
  const bad = await createOrder(P.checkout, "bad id!", "1");
  check("API rejects a malformed order id (400)", bad.status === 400, `${bad.status} ${show(bad.json)}`);

  const addrOf = {};
  const created = {};
  async function newOrder(port, id, amt) {
    const r = await createOrder(port, id, amt);
    created[id] = r;
    addrOf[id] = r.json.address;
    return r;
  }
  const C = P.checkout;

  // ===== 1 exact payment =====
  scenario("1 exact payment");
  if (want(1)) {
    const r = await newOrder(C, "s1", "0.5");
    check("create -> 201 pending, with a subaddress", r.status === 201 && r.json.status === "pending" && typeof r.json.address === "string" && r.json.address !== merchantAddress,
      `${r.status} ${show(r.json)}`);
    check("order address is a real regtest subaddress (95 chars, leading 8)", r.json.address.length === 95 && r.json.address[0] === "8", `first=${r.json.address[0]} len=${r.json.address.length}`);
    let v = await getOrder(C, "s1");
    check("GET before payment: pending, received 0", v.status === "pending" && v.received_atomic === "0" && v.amount_atomic === "500000000000", brief(v));
    await pay(addrOf.s1, "0.5");
    {
      // Diagnostic: how long until the real view-only wallet lists the pool tx?
      const minor1 = orderRowMinor(mainDb, "s1");
      const t = Date.now();
      let seenAt = null, refreshed = false;
      while (Date.now() - t < 90_000 && seenAt === null) {
        const g = await jsonRpc(P.merchantWallet, "get_transfers", { in: true, pool: true, account_index: 0, subaddr_indices: [minor1] });
        if ((g.json.result?.pool ?? []).length > 0) seenAt = Date.now() - t;
        else await sleep(1000);
      }
      note(`diagnostic: view-only wallet listed the pool tx after ${seenAt === null ? ">90000" : seenAt} ms (auto_refresh period 1s was set)`);
    }
    v = await waitOrder(C, "s1", "seen in pool", (x) => x.status === "seen", 60_000);
    check("in the pool: seen, confirmations 0, received 0.5", v.status === "seen" && v.confirmations === 0 && v.received_atomic === "500000000000" && v.confirmed_atomic === "0", brief(v));
    for (let want = 1; want <= CONFIRMATIONS; want++) {
      await mine(1);
      v = await waitOrder(C, "s1", `confirmations ${want}`, (x) => x.confirmations >= want || x.status === "paid");
      if (want < CONFIRMATIONS) {
        check(`after ${want} block(s): still seen, confirmations ${want}`, v.status === "seen" && v.confirmations === want, brief(v));
      } else {
        check(`after ${want} blocks: paid`, v.status === "paid" && v.confirmed_atomic === "500000000000", brief(v));
      }
    }
    const paidAt = v.paid_at;
    check("paid_at is set", typeof paidAt === "number" && paidAt > 0, `paid_at=${paidAt}`);
    await mine(1);
    await sleep((POLL_SECONDS + 2) * 1000);
    v = await getOrder(C, "s1");
    check("paid_at unchanged after another block + polls (written once)", v.status === "paid" && v.paid_at === paidAt, brief(v));
    // capture raw wallet shapes while we have confirmed + the pool example later
    raw.getTransfersIn = (await jsonRpc(P.merchantWallet, "get_transfers", { in: true, pool: true, account_index: 0, subaddr_indices: [orderRowMinor(mainDb, "s1")] })).text;
  }

  // ===== 2 underpayment then top-up =====
  scenario("2 underpay then top-up");
  if (want(2)) {
    await newOrder(C, "s2", "0.5");
    await pay(addrOf.s2, "0.2");
    let v = await waitOrder(C, "s2", "seen", (x) => x.status === "seen");
    check("0.2 of 0.5 in pool: seen, received 200000000000", v.status === "seen" && v.received_atomic === "200000000000", brief(v));
    await mine(CONFIRMATIONS);
    v = await waitOrder(C, "s2", "0.2 confirmed", (x) => x.confirmed_atomic === "200000000000");
    check("0.2 confirmed 3x: still seen (underpaid), confirmed 200000000000", v.status === "seen" && v.confirmed_atomic === "200000000000" && v.received_atomic === "200000000000", brief(v));
    await pay(addrOf.s2, "0.3");
    v = await waitOrder(C, "s2", "received 0.5", (x) => x.received_atomic === "500000000000");
    check("top-up in pool: received 500000000000 but not yet paid (seen)", v.status === "seen" && v.received_atomic === "500000000000" && v.confirmed_atomic === "200000000000", brief(v));
    await mine(CONFIRMATIONS);
    v = await waitOrder(C, "s2", "paid", (x) => x.status === "paid");
    check("after confirmations: paid, received 500000000000", v.status === "paid" && v.received_atomic === "500000000000" && v.confirmed_atomic === "500000000000", brief(v));
  }

  // ===== 3 overpayment =====
  scenario("3 overpayment");
  if (want(3)) {
    await newOrder(C, "s3", "0.5");
    await pay(addrOf.s3, "0.7");
    await mine(CONFIRMATIONS);
    const v = await waitOrder(C, "s3", "paid", (x) => x.status === "paid");
    check("0.7 for 0.5: paid, received_atomic 700000000000", v.status === "paid" && v.received_atomic === "700000000000" && v.amount_atomic === "500000000000", brief(v));
  }

  // ===== 4 isolation =====
  scenario("4 isolation");
  if (want(4)) {
    await newOrder(C, "s4a", "0.5");
    await newOrder(C, "s4b", "0.5");
    await pay(addrOf.s4a, "0.5");
    await mine(CONFIRMATIONS);
    const a = await waitOrder(C, "s4a", "paid", (x) => x.status === "paid");
    await sleep((POLL_SECONDS + 1) * 1000);
    const b = await getOrder(C, "s4b");
    check("paid order is paid", a.status === "paid", brief(a));
    check("other open order stays pending, received 0", b.status === "pending" && b.received_atomic === "0" && b.confirmations === 0, brief(b));
    check("two orders got two different subaddresses", addrOf.s4a !== addrOf.s4b);
  }

  // ===== 5 restart =====
  scenario("5 restart");
  if (want(5)) {
    const ids = ["s1", "s2", "s3", "s4a", "s4b"];
    await sleep((POLL_SECONDS + 1) * 1000);
    const before = {};
    for (const id of ids) before[id] = await getOrder(C, id);
    const creditsBefore = creditsRows(mainDb);
    note(`credits rows before restart: ${creditsBefore.length}`);
    await stopProc(main);
    main = startCheckout("checkout-main-restarted", C, mainDb, 60);
    await waitCheckout(C);
    await sleep((POLL_SECONDS * 3 + 1) * 1000);
    let same = true;
    const diffs = [];
    for (const id of ids) {
      const after = await getOrder(C, id);
      if (show(after) !== show(before[id])) { same = false; diffs.push(`${id}: ${brief(before[id])} -> ${brief(after)}`); }
    }
    check("all order views identical after restart + 3 polls", same, diffs.join(" | ") || "identical");
    const creditsAfter = creditsRows(mainDb);
    const sameCredits = show(creditsAfter) === show(creditsBefore);
    check("credits table unchanged after restart (no double count)", sameCredits, `${creditsBefore.length} -> ${creditsAfter.length} rows`);
    const bySub = new Map();
    for (const r of creditsAfter) bySub.set(r.subaddr_minor, (bySub.get(r.subaddr_minor) ?? 0n) + BigInt(r.amount_atomic));
    let sums = true;
    const sumDetail = [];
    for (const id of ["s1", "s2", "s3"]) {
      const minor = orderRowMinor(mainDb, id);
      const v = await getOrder(C, id);
      const ok = (bySub.get(minor) ?? 0n).toString() === v.received_atomic;
      sums &&= ok;
      sumDetail.push(`${id}: credits sum ${bySub.get(minor)} vs received ${v.received_atomic}`);
    }
    check("credits sums equal each order's received_atomic", sums, sumDetail.join("; "));
    try {
      const out = execFileSync("sqlite3", [mainDb, "SELECT subaddr_minor, substr(txid,1,12), amount_atomic, height, confirmations, double_spend_seen FROM credits ORDER BY subaddr_minor, txid;"], { encoding: "utf8", timeout: 10_000 });
      note("sqlite3 credits dump (minor|txid12|amount|height|conf|dbl):\n" + out.trim());
    } catch { note("sqlite3 CLI not available; used node:sqlite instead"); }
  }

  // ===== 6 pool drop =====
  scenario("6 pool drop (flush_txpool)");
  if (want(6)) {
    await newOrder(C, "s6", "0.5");
    const txid = await pay(addrOf.s6, "0.5");
    let v = await waitOrder(C, "s6", "seen", (x) => x.status === "seen");
    check("before flush: seen, confirmations 0", v.status === "seen" && v.confirmations === 0, brief(v));
    raw.getTransfersPool = (await jsonRpc(P.merchantWallet, "get_transfers", { in: true, pool: true, account_index: 0, subaddr_indices: [orderRowMinor(mainDb, "s6")] })).text;
    const poolBefore = await poolSize();
    const fl = await jsonRpc(P.daemonRpc, "flush_txpool", { txids: [txid] });
    note(`flush_txpool -> ${fl.text.replace(/\s+/g, " ")}`);
    const poolAfter = await poolSize();
    check("daemon pool really dropped the tx", poolAfter < poolBefore, `pool ${poolBefore} -> ${poolAfter}`);
    const samples = [];
    const start = Date.now();
    let dropped = null;
    while (Date.now() - start < 40_000) {
      await sleep(2000);
      const x = await getOrder(C, "s6");
      samples.push(`${Math.round((Date.now() - start) / 1000)}s:${x.status}/r=${x.received_atomic}`);
      if (x.status === "pending") { dropped = x; break; }
    }
    note(`samples after flush: ${samples.join(" ")}`);
    const wt = await jsonRpc(P.merchantWallet, "get_transfers", { in: true, pool: true, account_index: 0, subaddr_indices: [orderRowMinor(mainDb, "s6")] });
    note(`merchant wallet get_transfers after flush -> ${wt.text.replace(/\s+/g, " ").slice(0, 400)}`);
    v = await getOrder(C, "s6");
    check("README: seen order whose pool tx vanished goes back to pending", !!dropped, brief(v));
    note(`s6 credits rows: ${show(creditsRows(mainDb, orderRowMinor(mainDb, "s6")))}`);
  }

  // ===== 7 reorg after paid =====
  scenario("7 reorg after paid (pop_blocks)");
  if (want(7)) {
    await newOrder(C, "s7", "0.5");
    await pay(addrOf.s7, "0.5");
    await mine(CONFIRMATIONS);
    let v = await waitOrder(C, "s7", "paid", (x) => x.status === "paid");
    check("paid before the reorg", v.status === "paid", brief(v));
    const paidAtBefore = v.paid_at;
    const minor = orderRowMinor(mainDb, "s7");
    const rowsBefore = creditsRows(mainDb, minor);
    note(`before pop: order=${show(v)} credits=${show(rowsBefore)}`);
    const txHeight = rowsBefore[0]?.height;
    const tip = (await height()) - 1;
    const nPop = tip - txHeight + 1;
    note(`tx height ${txHeight}, tip ${tip}: popping ${nPop} block(s) so the tx is no longer confirmed`);
    const pb = await daemonPost("/pop_blocks", { nblocks: nPop });
    note(`pop_blocks -> ${show(pb)}`);
    check("pop_blocks accepted", pb.status === "OK", show(pb));
    await sleep(8000);
    const wt = await jsonRpc(P.merchantWallet, "get_transfers", { in: true, pool: true, account_index: 0, subaddr_indices: [minor] });
    note(`merchant wallet after pop -> ${wt.text.replace(/\s+/g, " ").slice(0, 500)}`);
    await sleep((POLL_SECONDS + 1) * 1000);
    v = await getOrder(C, "s7");
    const rowsAfter = creditsRows(mainDb, minor);
    note(`after pop: order=${show(v)} credits=${show(rowsAfter)}`);
    check("README: paid stays paid after the confirmations are reorged away; paid_at unchanged", v.status === "paid" && v.paid_at === paidAtBefore, `${brief(v)} (paid_at before: ${paidAtBefore})`);
    note(`wallet still lists the tx as confirmed after pop_blocks (no new block yet): ${(JSON.parse(wt.text).result?.in ?? []).map((t) => `conf=${t.confirmations} height=${t.height}`).join(", ") || "none"}`);
    // Stronger reorg: the tx does not come back at all (flush it from the pool, then build new blocks).
    const fl = await jsonRpc(P.daemonRpc, "flush_txpool", {});
    note(`flush_txpool (drop the popped tx for good) -> ${fl.text.replace(/\s+/g, " ")}`);
    await mine(CONFIRMATIONS + 1);
    await sleep(8000 + POLL_SECONDS * 1000);
    const wt2 = await jsonRpc(P.merchantWallet, "get_transfers", { in: true, pool: true, account_index: 0, subaddr_indices: [minor] });
    const listed = (JSON.parse(wt2.text).result?.in ?? []).length + (JSON.parse(wt2.text).result?.pool ?? []).length;
    note(`merchant wallet after the replacement blocks: ${listed} transfer(s) listed for this subaddress`);
    v = await getOrder(C, "s7");
    const rowsGone = creditsRows(mainDb, minor);
    note(`after the payment is truly gone: order=${show(v)} credits=${show(rowsGone)}`);
    check("README: payment reorged away for good, order stays paid (paid_at unchanged)", v.status === "paid" && v.paid_at === paidAtBefore, `${brief(v)}; wallet lists ${listed} transfer(s); credits rows=${rowsGone.length} (confirmations=${rowsGone[0]?.confirmations})`);
    note("credits row is frozen at its last poll: paid orders are no longer polled, so it still says height/confirmations from before the reorg");
    await mine(CONFIRMATIONS + 2); // restore a normal chain for what follows
    await sleep((POLL_SECONDS + 1) * 1000);
    v = await getOrder(C, "s7");
    check("still paid after the chain is rebuilt", v.status === "paid", brief(v));
  }

  // ===== 8 expiry + late payment =====
  scenario("8 expiry + late payment (ORDER_TTL_MINUTES=1)");
  if (want(8)) {
    const T = P.checkoutTtl;
    await newOrder(T, "s8", "0.5");
    let v = await getOrder(T, "s8");
    check("fresh short-TTL order is pending", v.status === "pending", brief(v));
    v = await waitOrder(T, "s8", "expired", (x) => x.status === "expired", 110_000);
    check("pending order becomes expired after the TTL", v.status === "expired" && v.late === false, brief(v));
    await pay(addrOf.s8, "0.5");
    v = await waitOrder(T, "s8", "seen late", (x) => x.status === "seen");
    check("payment to expired order: seen with late=true", v.status === "seen" && v.late === true && v.received_atomic === "500000000000", brief(v));
    await mine(CONFIRMATIONS);
    v = await waitOrder(T, "s8", "paid", (x) => x.status === "paid");
    check("then paid, late stays true", v.status === "paid" && v.late === true, brief(v));
  }

  // ===== 9 large amount (optional) =====
  scenario("9 amount above 2^53 piconero");
  if (process.env.E2E_LARGE === "1") {
    await scenario9(C, mainDb, newOrder, addrOf);
  } else {
    note("SKIPPED (set E2E_LARGE=1 to try; needs ~560 more blocks and many large sweep transactions)");
    results.push({ scenario: currentScenario, check: "skipped", ok: null, detail: "E2E_LARGE not set" });
  }

  // --- raw shapes for the report ---
  scenario("raw wallet-rpc shapes");
  note("create_address (real, from the probe call if it succeeded): " + (raw.createAddress ?? "n/a").replace(/\s+/g, " "));
  note("get_transfers confirmed (real): " + (raw.getTransfersIn ?? "n/a").replace(/\s+/g, " "));
  note("get_transfers pool (real): " + (raw.getTransfersPool ?? "n/a").replace(/\s+/g, " "));
}

async function scenario9(C, mainDb, newOrder, addrOf) {
  const LIMIT_MS = 15 * 60_000;
  const start = Date.now();
  const target = 9007199254740993n; // 2^53 + 1 piconero = 9007.199254740993 XMR
  await newOrder(C, "s9", "9007.199254740993");
  check("order above 2^53 keeps every digit in amount_atomic", (await getOrder(C, "s9")).amount_atomic === target.toString(), `amount_atomic=${(await getOrder(C, "s9")).amount_atomic}`);
  try {
    // block reward ~17.5 XMR; need ~520 mature blocks plus 60 for the unlock
    await mine(600);
    log(`mined 600 blocks, ${((Date.now() - start) / 1000).toFixed(0)}s elapsed`);
    await sRpc("refresh", {}, 110_000);
    const bal = await sRpc("get_balance", { account_index: 0 });
    note(`sender unlocked balance ${bal.unlocked_balance}`);
    if (BigInt(bal.unlocked_balance) < target) throw new Error("sender cannot reach 2^53 piconero yet");
    // sweep_all splits into as many transactions as needed.
    const sw = await sRpc("sweep_all", { address: addrOf.s9, account_index: 0, priority: 0, ring_size: 16, get_tx_keys: false }, 600_000);
    note(`sweep_all produced ${sw.tx_hash_list?.length} tx(s), amounts ${show(sw.amount_list)}`);
    if (Date.now() - start > LIMIT_MS) throw new Error("taking too long");
    // big txs may need several blocks to fit; mine until the pool is empty, then confirm
    for (let i = 0; i < 40 && (await poolSize()) > 0; i++) await mine(1);
    await mine(CONFIRMATIONS);
    const v = await waitOrder(C, "s9", "paid", (x) => x.status === "paid", 120_000);
    const tx = await jsonRpc(P.merchantWallet, "get_transfers", { in: true, pool: true, account_index: 0, subaddr_indices: [orderRowMinor(mainDb, "s9")] });
    const digits = [...tx.text.matchAll(/"amount":\s*(\d+)/g)].map((m) => BigInt(m[1]));
    const expected = digits.reduce((a, b) => a + b, 0n);
    note(`${digits.length} transfer entries, max single entry ${digits.reduce((a, b) => (a > b ? a : b), 0n)}, independent BigInt sum of raw JSON = ${expected}`);
    check("received_atomic equals the exact BigInt sum of the raw wallet JSON (>2^53)", v.received_atomic === expected.toString() && expected > 2n ** 53n, `${brief(v)} expected=${expected}`);
    check("order above 2^53 reaches paid", v.status === "paid", brief(v));
    note("no SINGLE transfer can exceed 2^53 on this chain (one tx would need >9007 XMR of inputs); only the SUM does, so the single-number BigInt parse path is covered by unit tests only");
  } catch (e) {
    note(`scenario 9 incomplete: ${e.message}`);
    results.push({ scenario: currentScenario, check: "incomplete", ok: null, detail: e.message });
  }
}

function summary() {
  console.log("\n===== SUMMARY =====");
  const by = new Map();
  for (const r of results) {
    const s = by.get(r.scenario) ?? { pass: 0, fail: 0, skip: 0 };
    if (r.ok === true) s.pass++; else if (r.ok === false) s.fail++; else s.skip++;
    by.set(r.scenario, s);
  }
  for (const [k, s] of by) console.log(`${s.fail ? "FAIL" : s.pass ? "PASS" : "SKIP"}  ${k}  (pass ${s.pass}, fail ${s.fail}, skipped ${s.skip})`);
  const fails = results.filter((r) => r.ok === false);
  console.log(`\n${results.filter((r) => r.ok === true).length} checks passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  FAILED [${f.scenario}] ${f.check} :: ${f.detail}`);
  return fails.length;
}

process.on("SIGINT", async () => { await stopAll(); process.exit(130); });
process.on("SIGTERM", async () => { await stopAll(); process.exit(143); });

try {
  await main();
} catch (e) {
  console.log(`${stamp()} ERROR ${e.stack ?? e}`);
  exitCode = 1;
} finally {
  await stopAll();
  const alive = procs.filter((p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } });
  console.log(`${stamp()} processes started: ${procs.map((p) => `${p.name}=${p.pid}`).join(" ")}; still alive: ${alive.length ? alive.map((p) => p.pid).join(",") : "none"}`);
  if (summary() > 0) exitCode = exitCode || 1;
}
process.exit(exitCode);
