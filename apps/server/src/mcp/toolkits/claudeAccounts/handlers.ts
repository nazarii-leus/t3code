import * as Effect from "effect/Effect";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ClaudeAccountsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ClaudeAccountsToolkit, {
  t3_claude_accounts: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const providers = yield* registry.getProviders;
      return {
        providers: providers.flatMap((provider) => {
          const snapshot = provider.accounts;
          if (!snapshot) return [];
          const name = (id: string | null) =>
            snapshot.accounts.find((account) => account.id === id)?.name ?? null;
          return [
            {
              instanceId: provider.instanceId,
              switching: snapshot.switching !== null,
              nextAccount: name(snapshot.autoSwitch.targetId),
              accounts: snapshot.accounts.map((account) => ({
                name: account.name,
                plan: account.plan,
                organization: account.organizationName,
                active: account.active,
                state: account.state,
                signInEndsAt: account.signInEndsAt,
                usage: (account.usageLimits?.windows ?? []).map((window) => ({
                  window: window.label,
                  leftPercent: Math.max(0, 100 - window.usedPercent),
                  resetsAt: window.resetsAt ?? null,
                })),
              })),
              recentSwitches: snapshot.history.slice(0, 5).map((entry) => ({
                at: entry.at,
                from: entry.fromName,
                to: entry.toName,
                reason: entry.reason,
              })),
            },
          ];
        }),
      };
    }),
  ),
});
