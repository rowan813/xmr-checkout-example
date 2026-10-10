/**
 * server.ts - the HTTP API, node:http only.
 *
 *   POST /orders      {id, amount_xmr} -> 201 {id, address, amount_xmr, status}
 *   GET  /orders/:id  -> the order view (status, totals, confirmations, ...)
 *
 * POST /orders has NO authentication. Call it from your own backend; do not
 * expose this server to the internet. Wiring and env vars live in main.ts.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Checkout, DuplicateOrderError, ValidationError } from "./checkout.ts";
import { WalletRpcError } from "./walletRpc.ts";

export const MAX_BODY_BYTES = 1_000_000;

class PayloadTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

/** Read the body; anything over the limit is drained and discarded, then rejected. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () =>
      size > MAX_BODY_BYTES
        ? reject(new PayloadTooLargeError())
        : resolve(Buffer.concat(chunks).toString("utf8"))
    );
    req.on("error", reject);
  });
}

async function createOrder(checkout: Checkout, req: IncomingMessage, res: ServerResponse) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) throw err;
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const { id, amount_xmr: amountXmr } = body;
  if (typeof id !== "string" || typeof amountXmr !== "string") {
    return sendJson(res, 400, { error: "Body must be {id: string, amount_xmr: string}" });
  }
  const view = await checkout.createOrder(id, amountXmr);
  sendJson(res, 201, { id: view.id, address: view.address, amount_xmr: amountXmr, status: view.status });
}

function getOrder(checkout: Checkout, rawId: string, res: ServerResponse) {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return sendJson(res, 400, { error: "Malformed order id in URL" });
  }
  const view = checkout.view(id);
  if (!view) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, view);
}

export function createApp(checkout: Checkout): Server {
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "POST" && path === "/orders") return await createOrder(checkout, req, res);
      if (req.method === "GET" && path.startsWith("/orders/")) {
        return getOrder(checkout, path.slice("/orders/".length), res);
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: "Body too large" });
      if (err instanceof ValidationError) return sendJson(res, 400, { error: err.message });
      if (err instanceof DuplicateOrderError) return sendJson(res, 409, { error: err.message });
      if (err instanceof WalletRpcError) return sendJson(res, 502, { error: err.message });
      console.error("unexpected error:", err instanceof Error ? err.message : err);
      sendJson(res, 500, { error: "Internal error" });
    }
  });
}
