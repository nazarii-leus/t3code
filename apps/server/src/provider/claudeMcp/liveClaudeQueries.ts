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

/** Returns how many sessions reconnected; a session that fails is dropped from the list. */
export async function reconnectLiveClaudeQueries(key: string, serverName: string): Promise<number> {
  const queries = live.get(key);
  if (!queries) return 0;
  let reconnected = 0;
  for (const query of queries) {
    try {
      await query.reconnectMcpServer(serverName);
      reconnected++;
    } catch {
      queries.delete(query);
    }
  }
  return reconnected;
}
