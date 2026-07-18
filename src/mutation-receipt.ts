export type CheckpointPersistence = "disabled" | "not_needed" | "pending" | "saved";

export const checkpointWithoutMutation = (session?: {
  checkpointPersistenceStatus?: () => "disabled" | "pending" | "saved";
}): CheckpointPersistence => session?.checkpointPersistenceStatus?.() ?? "not_needed";

export const mutationReceipt = (checkpoint: CheckpointPersistence) => ({
  applied: true as const,
  persisted: checkpoint === "saved" || checkpoint === "not_needed",
  checkpointPending: checkpoint === "pending",
});

export const persistAppliedMutation = async (session: {
  flushCheckpoint(): Promise<void>;
  persistCheckpointAfterMutation?: () => Promise<"disabled" | "pending" | "saved">;
  recoveryMode?: "durable" | "temporary";
  scheduleCheckpointRetry?: () => void;
}): Promise<CheckpointPersistence> => {
  if (session.persistCheckpointAfterMutation) return session.persistCheckpointAfterMutation();
  if (session.recoveryMode === "temporary") return "disabled";
  try {
    await session.flushCheckpoint();
    return "saved";
  } catch {
    session.scheduleCheckpointRetry?.();
    return "pending";
  }
};
