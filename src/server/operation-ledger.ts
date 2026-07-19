import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { currentOperationCommit, markOperationStarted } from "./operation-context.js";

type LedgerEntry<T> = {
  expiresAt: number;
  result: Promise<T>;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
};

const operationIdentities = new AsyncLocalStorage<string>();

const operationFingerprint = (namespace: string, toolName: string, input: unknown) => createHash("sha256")
  .update(namespace)
  .update("\0")
  .update(toolName)
  .update("\0")
  .update(JSON.stringify(canonicalize(input)))
  .digest("hex");

/**
 * Keeps only hashed operation identities. Room and Copy URLs never become map
 * keys or observable diagnostics. Settled results are retained briefly so a
 * client retry after an ambiguous timeout receives the original result.
 */
export class OperationLedger {
  readonly #entries = new Map<string, LedgerEntry<unknown>>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #namespace = randomBytes(32).toString("hex");

  constructor({ ttlMs = 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  run<T>(toolName: string, input: unknown, operation: () => Promise<T>): Promise<T> {
    return this.#run(toolName, input, operation, true);
  }

  /**
   * Coalesces only concurrent calls. Once the operation settles, a later call
   * executes again so it can report current session and presence state.
   */
  runInFlight<T>(toolName: string, input: unknown, operation: () => Promise<T>): Promise<T> {
    return this.#run(toolName, input, operation, false);
  }

  #run<T>(
    toolName: string,
    input: unknown,
    operation: () => Promise<T>,
    retainSettledResult: boolean,
  ): Promise<T> {
    const now = this.#now();
    this.#prune(now);
    const fingerprint = operationFingerprint(this.#namespace, toolName, input);
    const existing = this.#entries.get(fingerprint) as LedgerEntry<T> | undefined;
    if (existing) return existing.result;

    markOperationStarted(toolName);
    let result: Promise<T>;
    result = operationIdentities.run(fingerprint, operation)
      .catch((error) => {
        if (
          !currentOperationCommit().committed
          && this.#entries.get(fingerprint)?.result === result
        ) this.#entries.delete(fingerprint);
        throw error;
      })
      .finally(() => {
        if (
          !retainSettledResult
          && this.#entries.get(fingerprint)?.result === result
        ) this.#entries.delete(fingerprint);
      });
    this.#entries.set(fingerprint, { expiresAt: now + this.#ttlMs, result });
    return result;
  }

  #prune(now: number) {
    for (const [fingerprint, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(fingerprint);
    }
  }
}

export const currentOperationId = () => operationIdentities.getStore();
