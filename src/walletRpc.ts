/**
 * walletRpc.ts - a tiny JSON-RPC client for monero-wallet-rpc.
 *
 * Only the two methods this checkout needs:
 *   - create_address  (account_index 0, label = order id)
 *   - get_transfers   (in + pool, filtered by subaddr_indices)
 *
 * Field shapes follow https://docs.getmonero.org/rpc-library/wallet-rpc/ .
 * Fields the checkout does not use are left out of the types.
 *
 * HTTP digest auth is NOT implemented. Keep wallet-rpc on 127.0.0.1 behind
 * your own network boundary, or add digest auth yourself. See README.
 */

/** Any failure talking to wallet-rpc. The message is short and has no secrets. */
export class WalletRpcError extends Error {}

/** Result of create_address. */
export interface CreateAddressResult {
  address: string;
  /** Index of the new subaddress under the account (the "minor" index). */
  address_index: number;
}

/** One entry of the get_transfers "in" or "pool" array. */
export interface Transfer {
  /** Total received in this transaction, in piconero. */
  amount: bigint;
  /** If several outputs were received, each one individually. */
  amounts?: bigint[];
  /**
   * Blocks mined since the block containing the tx. Real wallet-rpc OMITS this
   * field on "pool" entries; getTransfers() fills in 0 so it is always a number.
   */
  confirmations: number;
  /** True if the key image(s) of this transfer were seen before. */
  double_spend_seen: boolean;
  /** Height of the first confirming block, 0 if not mined yet. */
  height: number;
  locked: boolean;
  /** The documented JSON object, NOT a number. */
  subaddr_index: { major: number; minor: number };
  timestamp: number;
  txid: string;
  type: string;
  unlock_time: number;
}

/** Result of get_transfers (only the arrays this checkout asks for). */
export interface GetTransfersResult {
  in?: Transfer[];
  pool?: Transfer[];
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * Parse a wallet-rpc response without losing precision.
 *
 * Piconero amounts can exceed 2^53 (an unsigned 64-bit value), which a plain
 * JSON.parse would round. Node 24's reviver receives the raw source text of
 * each primitive, so "amount" and the numbers inside "amounts" become BigInt
 * straight from the digits.
 */
export function parseWalletJson(text: string): unknown {
  function reviver(this: unknown, key: string, value: unknown, context?: { source?: string }) {
    const isAmount = key === "amount" || Array.isArray(this); // arrays of bare numbers: "amounts"
    if (isAmount && typeof value === "number" && context?.source !== undefined) {
      return BigInt(context.source);
    }
    return value;
  }
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

export class WalletRpcClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(url: string, timeoutMs = 10_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WalletRpcError(`wallet-rpc unreachable or timed out (${method})`);
    }
    if (!res.ok) throw new WalletRpcError(`wallet-rpc HTTP ${res.status} (${method})`);

    let data: JsonRpcResponse<T>;
    try {
      data = parseWalletJson(await res.text()) as JsonRpcResponse<T>;
    } catch {
      throw new WalletRpcError(`wallet-rpc sent invalid JSON (${method})`);
    }
    if (data.error) {
      throw new WalletRpcError(`wallet-rpc error ${data.error.code}: ${data.error.message}`);
    }
    if (data.result === undefined) {
      throw new WalletRpcError(`wallet-rpc returned no result (${method})`);
    }
    return data.result;
  }

  /** Create a new subaddress under account 0, labelled with the order id. */
  createAddress(label: string): Promise<CreateAddressResult> {
    return this.call("create_address", { account_index: 0, label });
  }

  /** Incoming transfers, confirmed ("in") and mempool ("pool"), for account 0. */
  async getTransfers(subaddrIndices: number[]): Promise<GetTransfersResult> {
    const result = await this.call<GetTransfersResult>("get_transfers", {
      in: true,
      pool: true,
      account_index: 0,
      subaddr_indices: subaddrIndices,
    });
    // Pool entries carry no "confirmations" key (verified against monero-wallet-rpc
    // v0.18.5.3). Unmined means 0 confirmations.
    const fill = (list?: Transfer[]) => list?.map((t) => ({ ...t, confirmations: t.confirmations ?? 0 }));
    return { in: fill(result.in), pool: fill(result.pool) };
  }
}
