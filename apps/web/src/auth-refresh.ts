export interface RefreshLockScheduler {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Cookie reads happen inside the origin-wide lock, after earlier tabs rotate it. */
export function serializedRefresh<T>(
  operation: () => Promise<T>,
  locks?: RefreshLockScheduler,
): Promise<T> {
  return locks ? locks.request("agentpanel.session.refresh", operation) : operation();
}
