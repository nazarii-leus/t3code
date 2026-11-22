// @effect-diagnostics nodeBuiltinImport:off - a plain module the adapter fills; it waits with Node timers.
import * as NodeTimersPromises from "node:timers/promises";

/**
 * Running Claude sessions by Claude folder, so a server signed in from Settings can be reconnected
 * in threads that are already running. Sessions register themselves and drop out when their process
 * exits.
 */
interface LiveClaudeQuery {
  readonly reconnectMcpServer: (serverName: string) => Promise<void>;
}

const live = new Map<string, Set<LiveClaudeQuery>>();

export const liveClaudeQueryKey = (environment: NodeJS.ProcessEnv | undefined): string =>
  environment?.CLAUDE_CONFIG_DIR?.trim() || "default";

export function trackLiveClaudeQuery(
  key: string,
  query: LiveClaudeQuery,
  exited: Promise<void> | undefined,
): void {
  const queries = live.get(key) ?? new Set<LiveClaudeQuery>();
  queries.add(query);
  live.set(key, queries);
  void exited?.finally(() => queries.delete(query));
}

const RECONNECT_TIMEOUT_MS = 10_000;

/**
 * Reconnects a server in every running session of a folder. A session that fails (it may not have
 * that server) stays listed; it drops out only when its process exits.
 */
export async function reconnectLiveClaudeQueries(
  key: string,
  serverName: string,
): Promise<{ readonly reconnected: number; readonly failed: number }> {
  const queries = [...(live.get(key) ?? [])];
  // All at once, so a stuck session delays the others by one timeout at most.
  const results = await Promise.allSettled(
    queries.map(async (query) => {
      const timeout = new AbortController();
      try {
        await Promise.race([
          query.reconnectMcpServer(serverName),
          NodeTimersPromises.setTimeout(RECONNECT_TIMEOUT_MS, undefined, {
            signal: timeout.signal,
          }).then(
            () => {
              throw new Error("timed out");
            },
            // Aborted once the reconnect settled.
            () => undefined,
          ),
        ]);
      } finally {
        timeout.abort();
      }
    }),
  );
  const reconnected = results.filter((result) => result.status === "fulfilled").length;
  const failed = results.length - reconnected;
  return { reconnected, failed };
}
