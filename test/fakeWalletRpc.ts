/**
 * fakeWalletRpc.ts - a fake monero-wallet-rpc served over loopback HTTP
 * (127.0.0.1, port 0), so tests exercise the real WalletRpcClient, including
 * its timeout and its precision-safe JSON parsing. No outside network.
 *
 * The get_transfers fixture is the example response from the official docs,
 * copied literally. One change: the docs page prints `"amounts" [200000000000]`
 * without the colon, which is not valid JSON, so the colon is added.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// https://docs.getmonero.org/rpc-library/wallet-rpc/#get_transfers
export const DOCS_GET_TRANSFERS_RESPONSE = `{
  "id": "0",
  "jsonrpc": "2.0",
  "result": {
    "in": [{
      "address": "77Vx9cs1VPicFndSVgYUvTdLCJEZw9h81hXLMYsjBCXSJfUehLa9TDW3Ffh45SQa7xb6dUs18mpNxfUhQGqfwXPSMrvKhVp",
      "amount": 200000000000,
      "amounts": [200000000000],
      "confirmations": 1,
      "double_spend_seen": false,
      "fee": 21650200000,
      "height": 153624,
      "locked": false,
      "note": "",
      "payment_id": "0000000000000000",
      "subaddr_index": {
        "major": 1,
        "minor": 0
      },
      "subaddr_indices": [{
        "major": 1,
        "minor": 0
      }],
      "suggested_confirmations_threshold": 1,
      "timestamp": 1535918400,
      "txid": "c36258a276018c3a4bc1f195a7fb530f50cd63a4fa765fb7c6f7f49fc051762a",
      "type": "in",
      "unlock_time": 0
    }]
  }
}`;

/** The docs' example entry, as a plain object to vary in tests. */
export const docsEntry = (JSON.parse(DOCS_GET_TRANSFERS_RESPONSE) as { result: { in: TransferJson[] } }).result.in[0]!;

export type TransferJson = Record<string, unknown> & {
  subaddr_index: { major: number; minor: number };
};

export interface FakeWalletState {
  /** Entries returned under "in" and "pool" (filtered by minor index). */
  in: TransferJson[];
  pool: TransferJson[];
  /** Next subaddress index create_address hands out (0 is the primary address). */
  nextIndex: number;
  /** Make every request fail with HTTP 500. */
  failHttp: boolean;
  /** get_transfers waits for this promise before answering. */
  hold?: Promise<void>;
  /** Method names received, in order. */
  calls: string[];
}

export interface FakeWallet {
  url: string;
  state: FakeWalletState;
  close(): Promise<void>;
}

/** JSON with bigint values written as plain digits (JSON.rawJSON, Node 22+). */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? JSON.rawJSON(v.toString()) : v));
}

export async function startFakeWalletRpc(): Promise<FakeWallet> {
  const state: FakeWalletState = { in: [], pool: [], nextIndex: 1, failHttp: false, calls: [] };

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { method, params } = JSON.parse(raw) as { method: string; params: Record<string, unknown> };
    state.calls.push(method);

    if (state.failHttp) {
      res.writeHead(500).end("boom");
      return;
    }

    let result: unknown;
    if (method === "create_address") {
      const index = state.nextIndex++;
      const address = `5FakeSubaddress${index}`;
      result = { address, address_index: index, address_indices: [index], addresses: [address] };
    } else if (method === "get_transfers") {
      await state.hold;
      // Filters by minor index only; major is left alone so tests can
      // check that the checkout itself ignores other accounts.
      const wanted = (params["subaddr_indices"] as number[] | undefined) ?? [];
      const pick = (list: TransferJson[]) => list.filter((t) => wanted.includes(t.subaddr_index.minor));
      result = { in: pick(state.in), pool: pick(state.pool) };
    } else {
      res.writeHead(200).end(toJson({ id: "0", jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(toJson({ id: "0", jsonrpc: "2.0", result }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/json_rpc`,
    state,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
