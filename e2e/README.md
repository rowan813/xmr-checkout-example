# End-to-end test against real Monero binaries (regtest)

`e2e/regtest.mjs` starts a private regtest chain with the real `monerod` and
two real `monero-wallet-rpc` processes, starts this repo's checkout server
against them, and runs the scenarios below. Regtest coins are worthless and
every wallet it creates is a throwaway. Nothing touches mainnet, stagenet or
any remote node.

## Requirements

- Node >= 24 (the repo runs `.ts` directly; `node:sqlite` is built in).
- The Monero CLI release for your platform, already downloaded, extracted and
  hash-checked by you. The script does not download anything. Verified with
  `monero-mac-x64-v0.18.5.3` (see https://www.getmonero.org/downloads/ for the
  release and its hashes). The directory must contain `monerod` and
  `monero-wallet-rpc`.
- `sqlite3` on the PATH is optional (used for one extra dump of the credits
  table).

## Run

```sh
MONERO_BIN_DIR=/path/to/monero-bin node e2e/regtest.mjs 2>&1 | tee e2e-run.txt
# or: node e2e/regtest.mjs /path/to/monero-bin
```

It took about 4 minutes on a slow Intel Mac (most of it is mining blocks and
one 60 second wait for the expiry scenario). Output is one `PASS`/`FAIL` line
per check with the observed values, then a summary. Exit code is 0 only if no
check failed.

Optional: `E2E_LARGE=1` also runs scenario 9 (an order above 2^53 piconero),
which mines about 600 more blocks and sweeps them in several large
transactions (adds about 6 minutes). The sum goes above 2^53, but no single
transfer can on this chain. `E2E_ONLY=1,6` runs only the listed scenarios (debugging; the
restart scenario 5 needs scenarios 1 to 4 first).

## What it starts (all on 127.0.0.1)

| process                   | port  | notes                                                   |
|---------------------------|-------|---------------------------------------------------------|
| `monerod`                 | 28881 | `--regtest --offline --fixed-difficulty 1`, P2P on 28880 |
| `monero-wallet-rpc` sender   | 38084 | full wallet, funded by `generateblocks`              |
| `monero-wallet-rpc` merchant | 38083 | view-only wallet from `generate_from_keys` (README step 3) |
| checkout server (main)    | 38090 | 3 confirmations, 2 s polls, 60 minute TTL               |
| checkout server (short TTL) | 38091 | same, `ORDER_TTL_MINUTES=1`, used for the expiry scenario |

Every PID is recorded in `<run dir>/pids.json` and all of them are stopped at
the end (also on Ctrl-C).

The run directory defaults to `<MONERO_BIN_DIR>/../run`; override with
`REGTEST_RUN_DIR`. The script deletes that directory at the start of a run, but
only if it carries the marker file the script itself wrote, so it will refuse
to wipe a directory it did not create.

Two details that matter if you adapt this:

- Both Monero binaries are given an empty `--config-file`. Without it
  `monerod` reads `~/.bitmonero/bitmonero.conf`, and a `restricted-rpc=1` line
  there silently hides `generateblocks`, `flush_txpool` and `/pop_blocks`
  (the calls then fail with "Method not found").
- Both wallet-rpc processes get a `--shared-ringdb-dir` inside the run
  directory, otherwise spending records rings in `~/.shared-ringdb`.

## Scenarios

1. Exact payment: pending, then seen in the pool (0 confirmations), then
   confirmations 1, 2, then paid at 3; `paid_at` written once.
2. Underpayment then top-up: 0.2 of 0.5 stays seen, 0.3 more reaches paid.
3. Overpayment: 0.7 for 0.5 is paid with `received_atomic` 0.7.
4. Isolation: paying one of two open orders leaves the other pending.
5. Restart: stop and restart the checkout server on the same database;
   views and the credits table are unchanged.
6. Pool drop: pay, then `flush_txpool` on the daemon while unconfirmed.
7. Reorg after paid: `pop_blocks` removes the confirmations of a paid order.
8. Expiry then late payment (60 second TTL): expired, then a payment gives
   `late: true`.
9. (`E2E_LARGE=1`) An amount above 2^53 piconero keeps every digit.

The script also records the raw `create_address` and `get_transfers` JSON from
the real wallet, `query_key spend_key` on the view-only wallet, and whether
`open_wallet` was needed after `generate_from_keys`.
