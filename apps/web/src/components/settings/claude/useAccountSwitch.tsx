import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { switchConfirmLines } from "@t3tools/client-runtime/provider-accounts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderAccount, ServerProvider } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { createContext, useState } from "react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { randomUUID } from "../../../lib/utils";
import { useThreadShells } from "../../../state/entities";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";

const WORKING = new Set(["starting", "running", "waiting"]);

/** Tells this window's own switches apart from other clients' in the switch history. */
export const providerAccountsClientId: string | null = (() => {
  try {
    const key = "t3:provider-accounts-client";
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const next = randomUUID();
    window.sessionStorage.setItem(key, next);
    return next;
  } catch {
    return null;
  }
})();

export const formatAccountTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Lets surfaces without their own dialog host (the command palette) run a switch. */
export const AccountSwitchContext = createContext<((target: AccountSwitchTarget) => void) | null>(
  null,
);

export interface AccountSwitchTarget {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly account: ProviderAccount;
}

/**
 * Switches a provider's active account: at once when nothing is at stake, otherwise after a
 * confirm that names the working threads, models the target can't run and its reset time.
 * Render `dialog` once next to the caller.
 */
export function useAccountSwitch() {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const runSwitch = useAtomCommand(serverEnvironment.switchProviderAccount, {
    reportFailure: false,
    reportDefect: false,
  });
  const shells = useThreadShells();
  const workingOf = (environmentId: EnvironmentId, instanceId: string) =>
    shells.filter(
      (shell) =>
        shell.environmentId === environmentId &&
        shell.providerInstanceId === instanceId &&
        WORKING.has(shell.latestRun?.status ?? ""),
    );
  const [confirm, setConfirm] = useState<{
    readonly target: AccountSwitchTarget;
    readonly lines: ReadonlyArray<string>;
  } | null>(null);

  async function doUse({ environmentId, provider, account }: AccountSwitchTarget) {
    setConfirm(null);
    const result = await runSwitch({
      environmentId,
      input: {
        instanceId: provider.instanceId,
        accountId: account.id,
        clientKind: window.desktopBridge ? "desktop" : "web",
        ...(providerAccountsClientId ? { clientId: providerAccountsClientId } : {}),
      },
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Claude now uses {name}", { name: account.name }),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Couldn't switch the Claude account"),
        description:
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : undefined,
      });
    }
  }

  function requestUse(target: AccountSwitchTarget) {
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
      now: Date.parse(`${nowMinute}:00Z`),
      formatTime: formatAccountTime,
      resolve: m,
    });
    if (lines.length === 0) void doUse(target);
    else setConfirm({ target, lines });
  }

  const dialog = (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {gt("Switch Claude to {name}?", { name: confirm?.target.account.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription render={<div className="grid gap-2" />}>
            {confirm?.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button onClick={() => confirm && void doUse(confirm.target)}>
            <T>Switch</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return {
    requestUse,
    dialog,
    workingThreads: (environmentId: EnvironmentId, instanceId: string) =>
      workingOf(environmentId, instanceId).length,
  };
}
