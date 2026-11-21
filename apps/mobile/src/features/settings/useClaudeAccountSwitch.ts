import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { switchConfirmLines } from "@t3tools/client-runtime/provider-accounts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderAccount, ServerProvider } from "@t3tools/contracts";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const WORKING = new Set(["starting", "running", "waiting"]);

/** Tells this app's own switches apart from other clients' in the switch history. */
export const mobileAccountsClientId = uuidv4();

export const formatAccountTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

export interface AccountSwitchTarget {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly account: ProviderAccount;
}

/**
 * Switches a provider's active account: at once when nothing is at stake, otherwise after a
 * confirm naming the working threads, the models the account can't run and its reset time.
 */
export function useClaudeAccountSwitch() {
  const gt = useGT();
  const shells = useThreadShells();
  const runSwitch = useAtomCommand(serverEnvironment.switchProviderAccount, {
    reportFailure: false,
    reportDefect: false,
  });
  const workingOf = (environmentId: EnvironmentId, instanceId: string) =>
    shells.filter(
      (shell) =>
        shell.environmentId === environmentId &&
        shell.providerInstanceId === instanceId &&
        WORKING.has(shell.latestRun?.status ?? ""),
    );

  async function doSwitch({ environmentId, provider, account }: AccountSwitchTarget) {
    const result = await runSwitch({
      environmentId,
      input: {
        instanceId: provider.instanceId,
        accountId: account.id,
        clientKind: "mobile",
        clientId: mobileAccountsClientId,
      },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    Dialog.alert(
      gt("Couldn't switch the Claude account"),
      failure instanceof Error ? (errorDisplayMessage(failure, m) ?? failure.message) : undefined,
    );
  }

  function requestSwitch(target: AccountSwitchTarget) {
    const working = workingOf(target.environmentId, target.provider.instanceId);
    const models = new Map<string, { id: string; name: string; threads: number }>();
    for (const shell of working) {
      const id = shell.modelSelection.model;
      const name = target.provider.models.find((model) => model.slug === id)?.name ?? id;
      const entry = models.get(id) ?? { id, name, threads: 0 };
      models.set(id, { ...entry, threads: entry.threads + 1 });
    }
    const lines = switchConfirmLines({
      target: target.account,
      workingThreads: working.length,
      modelsInUse: [...models.values()],
      now: Date.now(),
      formatTime: formatAccountTime,
      resolve: m,
    });
    if (lines.length === 0) {
      void doSwitch(target);
      return;
    }
    Dialog.confirm({
      title: gt("Switch Claude to {name}?", { name: target.account.name }),
      message: lines.join("\n\n"),
      cancelText: gt("Cancel"),
      confirmText: gt("Switch"),
      onConfirm: () => void doSwitch(target),
    });
  }

  return {
    requestSwitch,
    workingThreads: (environmentId: EnvironmentId, instanceId: string) =>
      workingOf(environmentId, instanceId).length,
  };
}
