import { AsyncLocalStorage } from "node:async_hooks";

export type OperationCommit = {
  committed: boolean;
  committedAt?: string;
  kind?: string;
};

type OperationContext = {
  signal: AbortSignal;
  commit: OperationCommit;
};

const operationContexts = new AsyncLocalStorage<OperationContext>();
const operationStates = new WeakMap<AbortSignal, OperationCommit>();

export class OperationAbortedError extends Error {
  constructor() {
    super("The MCP operation was cancelled before it committed.");
    this.name = "OperationAbortedError";
  }
}

export const runWithOperationSignal = <T>(signal: AbortSignal, operation: () => Promise<T>) => {
  const commit = operationStates.get(signal) ?? { committed: false };
  operationStates.set(signal, commit);
  return operationContexts.run({ signal, commit }, operation);
};

export const currentOperationSignal = () => operationContexts.getStore()?.signal;

export const operationCommitForSignal = (signal: AbortSignal): OperationCommit =>
  operationStates.get(signal) ?? { committed: false };

export const currentOperationCommit = (): OperationCommit =>
  operationContexts.getStore()?.commit ?? { committed: false };

export const markOperationCommitted = (kind: string) => {
  const context = operationContexts.getStore();
  if (!context || context.commit.committed) return;
  context.commit.committed = true;
  context.commit.committedAt = new Date().toISOString();
  context.commit.kind = kind;
};

export const markOperationStarted = (kind: string) => {
  const context = operationContexts.getStore();
  if (!context || context.commit.kind) return;
  context.commit.kind = kind;
};

export const throwIfOperationAborted = () => {
  if (currentOperationSignal()?.aborted) throw new OperationAbortedError();
};

export const abortableOperation = <T>(operation: Promise<T>, onAbort?: () => void): Promise<T> => {
  const signal = currentOperationSignal();
  if (!signal) return operation;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(new OperationAbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      onAbort?.();
      reject(new OperationAbortedError());
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
};
