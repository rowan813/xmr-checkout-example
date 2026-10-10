# xmr-checkout-example

A small, honest example of accepting Monero for orders.

One subaddress per order. A view-only wallet watches for incoming payments.
An order is marked `paid` after a confirmation count you choose. Your database
is updated once per payment even if the payment is seen twice.

This is example code, not a production payment processor. It exists so a
reviewer can read it in 15 minutes and trust it.

## The view-only design

The wallet behind `monero-wallet-rpc` is **view-only**: created with
`generate_from_keys` from your address and private view key, with no spend
key. This server can see incoming payments but **cannot move funds**.
Spending stays with you, on a different machine, with a full wallet.

No spend key, seed, or private key appears anywhere in this repository.

## How it works

```
POST /orders {id, amount_xmr}
  -> creates a subaddress labelled with the order id
  -> returns {id, address, amount_xmr, status}

GET /orders/:id
  -> {id, address, amount_atomic, status, received_atomic, confirmed_atomic,
      confirmations, late, double_spend_flagged, created_at, paid_at}
```

A background poller (every `POLL_SECONDS`, default 30) calls `get_transfers`
(`in` and `pool`, account 0) for the subaddresses of open orders and
**recomputes each order's totals from that response alone**. Entries with
`subaddr_index.major` other than 0, and entries with `double_spend_seen: true`,
are not counted. Confirmations come from each entry's own `confirmations`
field.

The `credits` table is an append-only audit log of every transfer seen
(`txid` + minor index, `height` and `confirmations` refreshed on later
polls). It is never used to decide a status, so a reorg or a dropped pool
transaction cannot leave a stale credit behind. This relies on the wallet
returning one entry per transaction per subaddress; the docs do not promise
that.

| status    | meaning                                                                   |
|-----------|---------------------------------------------------------------------------|
| `pending` | nothing in the pool or chain right now                                    |
| `seen`    | something is in the pool or chain, but not enough confirmed yet           |
| `paid`    | transfers with `confirmations >= REQUIRED_CONFIRMATIONS` sum to >= amount |
| `expired` | `ORDER_TTL_MINUTES` passed while nothing was seen                         |

- `received_atomic`: everything currently counted (confirmed and pool).
  `confirmed_atomic`: the part with enough confirmations. `confirmations`:
  the fewest among the counted transfers (0 if none).
- A `seen` order whose pool transaction disappears goes back to `pending`,
  and the normal expiry applies.
- Once `paid`, an order stays `paid` and `paid_at` is written once.
- **Late payments.** Expired orders are still polled for `LATE_PAYMENT_DAYS`
  (default 7). A payment to an expired order moves it to `seen` or `paid` and
  sets `late: true`, so no payment is silently ignored. Your code decides
  what to do with a late order (fulfil, refund, contact the customer).
- Transfers the wallet flags `double_spend_seen` never count. They are
  counted in `double_spend_flagged` so you can look at them.
- Underpayment stays `seen` with the received total exposed. Overpayment is
  `paid` with the extra exposed. There are no automatic refunds.
- Amounts are piconero strings in the API and `BigInt` in the code. The
  wallet-rpc response is parsed so that amounts above 2^53 (up to 2^64-1)
  keep every digit.

## Running against stagenet

You need `monerod` and `monero-wallet-rpc` from the Monero project, running
on stagenet. Download them from https://www.getmonero.org/downloads/.
Flags marked "check with --help" were not found on the wallet-rpc docs page
and may differ between versions.

1. Start the daemon (`--stagenet`: check with --help):

   ```sh
   monerod --stagenet
   ```

2. Start wallet-rpc with a wallet directory. The docs say `--wallet-dir` is
   required for creating wallets over RPC. The wallet-rpc docs mention
   `--rpc-login username:password`; the other flags below are "check with
   --help":

   ```sh
   monero-wallet-rpc --stagenet \
     --wallet-dir ./wallets \
     --rpc-bind-ip 127.0.0.1 \
     --rpc-bind-port 38083 \
     --rpc-login user:pass
   ```

   This example does not implement HTTP digest auth, so for local testing
   you may start it with `--disable-rpc-login` instead (check with --help).
   Keep wallet-rpc on 127.0.0.1 behind your own network boundary.

3. Create the view-only wallet with the `generate_from_keys` method. Use the
   parameters as the docs list them: `address`, `viewkey`, `filename`,
   `password`, `restore_height`. Leave `spendkey` out; the docs say omitting
   it creates a view-only wallet. Set `restore_height` to roughly the block
   where you created the address; the default of 0 scans the whole chain.

   ```sh
   curl -s http://127.0.0.1:38083/json_rpc \
     -d '{"jsonrpc":"2.0","id":"0","method":"generate_from_keys","params":{
           "address":"<your stagenet primary address>",
           "viewkey":"<your private view key>",
           "filename":"checkout-view",
           "password":"<a password>",
           "restore_height":<block height>}}' \
     -H 'Content-Type: application/json'
   ```

   (Add `--user user:pass --digest` to curl if you started wallet-rpc with
   `--rpc-login`.) The docs do not say whether the new wallet is left open
   for the following calls; if `create_address` complains that no wallet is
   open, call `open_wallet` with the same `filename` and `password`.

4. Start the checkout server:

   ```sh
   WALLET_RPC_URL=http://127.0.0.1:38083/json_rpc \
   DB_PATH=./checkout.db \
   node src/main.ts
   ```

5. Create an order:

   ```sh
   curl -s -X POST http://127.0.0.1:8080/orders \
     -H 'Content-Type: application/json' \
     -d '{"id": "order-001", "amount_xmr": "0.5"}'
   ```

   Send stagenet XMR to the returned address, then watch the status:

   ```sh
   curl -s http://127.0.0.1:8080/orders/order-001
   ```

## Environment variables

| variable                 | default                              | meaning                                   |
|--------------------------|--------------------------------------|-------------------------------------------|
| `WALLET_RPC_URL`         | `http://127.0.0.1:38083/json_rpc`    | wallet-rpc endpoint                       |
| `WALLET_RPC_TIMEOUT_MS`  | `10000`                              | per-request timeout                       |
| `DB_PATH`                | `./checkout.db`                      | SQLite file                               |
| `REQUIRED_CONFIRMATIONS` | `10`                                 | confirmations before `paid` (at least 1)  |
| `ORDER_TTL_MINUTES`      | `60`                                 | expiry when nothing was seen              |
| `LATE_PAYMENT_DAYS`      | `7`                                  | how long expired orders are still polled  |
| `POLL_SECONDS`           | `30`                                 | poller interval                           |
| `HOST`                   | `127.0.0.1`                          | HTTP listen address                       |
| `PORT`                   | `8080`                               | HTTP listen port                          |

A poll never overlaps the previous one. If a poll fails (wallet-rpc down,
timeout) one line is logged and the next tick retries.

## Confirmation trade-off

More confirmations = more certainty the payment will not be reorganized
away, but the customer waits longer. Fewer = faster checkout, more risk.
The commonly cited rule of thumb is a 10-block spend lock (about 20 minutes)
before treating Monero as settled; that figure is community practice, not an
official recommendation from the Monero docs. Choose what fits your risk
model. The docs describe `get_transfers` returning a `confirmations` field per
transfer, and this example uses it directly.

## Limits (read before using)

- **No refunds.** Overpayment is marked `paid` and the extra is exposed in
  the API response, but no refund transaction is created.
- **`POST /orders` has no authentication.** Anyone who can reach it can
  create orders and subaddresses without limit. It must sit behind your own
  backend and is not for direct exposure to the internet. The server binds to
  `127.0.0.1` by default; request bodies are limited to 1 MB.
- **No HTTP digest auth** to wallet-rpc. wallet-rpc supports it; this example
  does not implement it. Protect the network path yourself.
- **Single wallet account** (account_index 0). Subaddresses are created
  under that one account.
- **Not audited.** Tested against a stub of monero-wallet-rpc built from the
  docs' own example responses. Not reviewed by a third party.
- **One checkout server.** No horizontal scaling, no queue, no retries
  beyond the simple interval poller.

## Status

Unit-tested against a stub of monero-wallet-rpc built from the official
docs. **NOT yet run end to end on stagenet; that run is the next step.**

An earlier draft used response shapes that did not match the docs; an independent review caught it before publishing, and the stub is now built from the docs' own example responses.

## Tests

```sh
node --test
```

The tests start a fake wallet-rpc on `127.0.0.1` (random port) whose
`get_transfers` fixture is the docs' example response, copied literally
(the docs page prints `"amounts" [..]` without a colon; the colon is added),
then varied. The real client, the real poller logic and the HTTP server are
exercised. Nothing leaves the machine.

## API

### POST /orders

No authentication. Call it from your own backend.

Request:
```json
{"id": "order-001", "amount_xmr": "0.5"}
```

- `id`: 1-64 characters of `[A-Za-z0-9._-]`
- `amount_xmr`: positive decimal, max 12 decimal places

Response `201`:
```json
{"id": "order-001", "address": "7...", "amount_xmr": "0.5", "status": "pending"}
```

Errors: `400` invalid JSON or fields, `409` duplicate id, `413` body over
1 MB, `502` wallet-rpc unreachable or returned an error.

### GET /orders/:id

Response `200` (an underpaid order with 4 confirmations on the transfer):
```json
{
  "id": "order-001",
  "address": "7...",
  "amount_atomic": "500000000000",
  "status": "seen",
  "received_atomic": "300000000000",
  "confirmed_atomic": "0",
  "confirmations": 4,
  "late": false,
  "double_spend_flagged": 0,
  "created_at": 1728576000000,
  "paid_at": null
}
```

Errors: `400` malformed URL encoding, `404` not found.

## License

MIT. See LICENSE.

## Authorship

Written by Rowan, an AI agent working for N3uroniK (Fleur Collective, L.L.C.), with an independent AI code review before publishing.
