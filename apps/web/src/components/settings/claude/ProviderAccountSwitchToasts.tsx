import type { AnyRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { m } from "../../../i18n/messages";
import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { environmentPresentations } from "../../../state/presentation";
import { toastManager } from "../../ui/toast";
import { providerAccountsClientId } from "./useAccountSwitch";

/**
 * Toasts account switches this window did not start: automatic ones and those from other
 * windows or the phone. Entries that existed when the window first saw a provider are skipped.
 */
export function startProviderAccountSwitchToasts(router: AnyRouter): () => void {
  const seen = new Map<string, string>();
  return appAtomRegistry.subscribe(
    environmentPresentations.presentationsWithProvidersAtom,
    (presentations) => {
      for (const [environmentId, presentation] of presentations) {
        for (const provider of presentation.serverConfig?.providers ?? []) {
          const history = provider.accounts?.history;
          if (!history) continue;
          const key = `${environmentId}:${provider.instanceId}`;
          const latest = history[0]?.at ?? "";
          const previous = seen.get(key);
          seen.set(key, latest);
          if (previous === undefined) continue;
          const fresh = history.filter((entry) => entry.at > previous).toReversed();
          for (const entry of fresh) {
            if (
              entry.initiator.clientId !== null &&
              entry.initiator.clientId === providerAccountsClientId
            ) {
              continue;
            }
            const where =
              presentations.size > 1
                ? m(msg(" on {environment}", { environment: presentation.entry.target.label }))
                : "";
            const openAccounts = () =>
              void router.navigate({
                to: "/settings/providers",
                search: { environmentId, instanceId: provider.instanceId },
                hash: "claude-accounts",
              });
            if (entry.reason === "usage_limit") {
              toastManager.add({
                type: "info",
                title: `${m(msg("Claude switched to {name}", { name: entry.toName }))}${where}`,
                description: m(
                  msg("{name} ran out of usage ({window}).", {
                    name: entry.fromName ?? "",
                    window: entry.window ?? "",
                  }),
                ),
                actionProps: { children: m(msg("Accounts")), onClick: openAccounts },
              });
            } else if (entry.reason === "manual") {
              toastManager.add({
                type: "info",
                title: `${m(msg("Claude now uses {name}", { name: entry.toName }))}${where}`,
                description:
                  entry.initiator.kind === "mobile"
                    ? m(msg("From your phone."))
                    : m(msg("From another window.")),
              });
            }
          }
        }
      }
    },
  );
}
