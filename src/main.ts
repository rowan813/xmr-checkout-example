/**
 * main.ts - reads the environment, wires everything together, starts the
 * HTTP server and the poller.
 *
 *   WALLET_RPC_URL          default http://127.0.0.1:38083/json_rpc (stagenet)
 *   WALLET_RPC_TIMEOUT_MS   default 10000
 *   DB_PATH                 default ./checkout.db
 *   REQUIRED_CONFIRMATIONS  default 10 (at least 1)
 *   ORDER_TTL_MINUTES       default 60
 *   LATE_PAYMENT_DAYS       default 7
 *   POLL_SECONDS            default 30
 *   HOST                    default 127.0.0.1
 *   PORT                    default 8080
 */

import { Checkout } from "./checkout.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import { WalletRpcClient } from "./walletRpc.ts";

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

const walletUrl = process.env.WALLET_RPC_URL ?? "http://127.0.0.1:38083/json_rpc";
const dbPath = process.env.DB_PATH ?? "./checkout.db";
const host = process.env.HOST ?? "127.0.0.1";
const port = intFromEnv("PORT", 8080, 0);
const pollSeconds = intFromEnv("POLL_SECONDS", 30, 1);

const checkout = new Checkout(
  new Store(dbPath),
  new WalletRpcClient(walletUrl, intFromEnv("WALLET_RPC_TIMEOUT_MS", 10_000, 1)),
  {
    requiredConfirmations: intFromEnv("REQUIRED_CONFIRMATIONS", 10, 1),
    orderTtlMinutes: intFromEnv("ORDER_TTL_MINUTES", 60, 1),
    latePaymentDays: intFromEnv("LATE_PAYMENT_DAYS", 7, 0),
  }
);

// pollOnce skips itself if the previous poll is still running. A failed poll
// logs one line and the next tick tries again.
setInterval(() => {
  checkout.pollOnce().catch((err) => {
    console.error(`poll failed: ${err instanceof Error ? err.message : err}`);
  });
}, pollSeconds * 1000).unref();

createApp(checkout).listen(port, host, () => {
  console.log(`xmr-checkout-example listening on http://${host}:${port}`);
});
