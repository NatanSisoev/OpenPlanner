/** Thrown when MongoDB plan sync fails (replaces former HTTP RemoteSyncError). */
export class PlanSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanSyncError";
  }
}
