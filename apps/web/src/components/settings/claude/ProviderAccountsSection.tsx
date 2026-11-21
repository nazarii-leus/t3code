import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  accountRowModel,
  switchReasonText,
  type AccountMenuItem,
} from "@t3tools/client-runtime/provider-accounts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_ACCOUNT_ADD_METHOD_ID,
  PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX,
  type EnvironmentId,
  type ProviderAccount,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { MoreVertical, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { ensureLocalApi } from "../../../localApi";
import { cn } from "../../../lib/utils";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Alert, AlertAction, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { DraftInput } from "../../ui/draft-input";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import { LimitWindows } from "../../usage/UsageLimits";
import { ProviderAuthenticationSection } from "../ProviderAuthenticationSection";
import { RedactedSensitiveText } from "../RedactedSensitiveText";
import { ScopedSwitch } from "../ScopedSwitch";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "../useScopedSettings";
import { AccountChip } from "../../usage/AccountChip";
import { formatAccountTime, providerAccountsClientId, useAccountSwitch } from "./useAccountSwitch";

const COMMANDS = { reportFailure: false, reportDefect: false } as const;
const toneDot: Record<string, string | null> = {
  warning: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/60",
  plain: null,
  busy: null,
};

export function ProviderAccountsSection({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const snapshot = provider.accounts!;
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const formatTime = formatAccountTime;
  const auth = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
    m,
  ).data;
  const start = useAtomCommand(serverEnvironment.startProviderAuth, COMMANDS);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, COMMANDS);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, COMMANDS);
  const remove = useAtomCommand(serverEnvironment.removeProviderAccount, COMMANDS);
  const rename = useAtomCommand(serverEnvironment.renameProviderAccount, COMMANDS);
  const setAutoSwitch = useAtomCommand(serverEnvironment.setProviderAccountAutoSwitch, COMMANDS);
  const checkUsage = useAtomCommand(serverEnvironment.checkProviderAccountsUsage, COMMANDS);
  const resume = useAtomCommand(serverEnvironment.resumeProviderAccountsAutoSwitch, COMMANDS);
  const accountSwitch = useAccountSwitch();
  const requestUse = (account: ProviderAccount) =>
    accountSwitch.requestUse({ environmentId, provider, account });
  const switchEnabled = useScopedSettings((settings) => settings.switchAccountsAtUsageLimits);
  const updateSettings = useUpdateScopedSettings();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const flowActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const flowMethod = auth?.methodId ?? null;
  const accountFlow = flowMethod?.startsWith("account:") ? flowMethod : null;
  const showFlow = (methodId: string) =>
    accountFlow === methodId && (flowActive || auth?.phase === "failed");

  async function outcome(result: AtomCommandResult<unknown, unknown>, failureTitle: string) {
    if (result._tag === "Success") return true;
    if (isAtomCommandInterrupted(result)) return false;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: failureTitle,
      description:
        failure instanceof Error ? (thrownErrorMessage(failure, m) ?? failure.message) : undefined,
    });
    return false;
  }

  async function signIn(methodId: string) {
    if (methodId === PROVIDER_ACCOUNT_ADD_METHOD_ID) setAddOpen(true);
    await outcome(
      await start({ environmentId, input: { instanceId, methodId } }),
      gt("Could not start sign-in"),
    );
  }

  async function onMenu(account: ProviderAccount, item: AccountMenuItem) {
    const target = { environmentId, input: { instanceId, accountId: account.id } };
    switch (item) {
      case "use":
        return requestUse(account);
      case "check-usage":
        return outcome(
          await checkUsage({ environmentId, input: { instanceId, accountId: account.id } }),
          gt("Couldn't check usage"),
        );
      case "sign-in":
      case "sign-in-again":
        return signIn(`${PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX}${account.id}`);
      case "auto-switch-off":
      case "auto-switch-on":
        return outcome(
          await setAutoSwitch({
            ...target,
            input: { ...target.input, enabled: item === "auto-switch-on" },
          }),
          gt("Couldn't change automatic switching"),
        );
      case "rename":
        setRenameError(null);
        return setRenaming(account.id);
      case "copy-email":
        if (account.email) {
          await writeTextToClipboard(account.email);
          toastManager.add({ type: "success", title: gt("Email copied") });
        }
        return;
      case "sign-out": {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          gt(
            "Sign out of Claude on {environment}? This stops running threads that share this sign-in. Thread history is kept.",
            { environment: environmentLabel },
          ),
          { variant: "destructive" },
        );
        if (confirmed)
          await outcome(
            await logout({ environmentId, input: { instanceId } }),
            gt("Couldn't sign out"),
          );
        return;
      }
      case "remove": {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          gt(
            "Remove {name} from T3? T3 signs it out on this computer. Threads and their history stay.",
            {
              name: account.name,
            },
          ),
          { variant: "destructive" },
        );
        if (confirmed && (await outcome(await remove(target), gt("Couldn't remove the account")))) {
          toastManager.add({
            type: "success",
            title: gt("Removed {name}", { name: account.name }),
          });
        }
        return;
      }
    }
  }

  const menuLabel = (item: AccountMenuItem) =>
    ({
      use: gt("Use"),
      "check-usage": gt("Check usage"),
      "sign-in": gt("Sign in"),
      "sign-in-again": gt("Sign in again"),
      "auto-switch-off": gt("Leave out of automatic switching"),
      "auto-switch-on": gt("Include in automatic switching"),
      rename: gt("Rename…"),
      "copy-email": gt("Copy email"),
      "sign-out": gt("Sign out…"),
      remove: gt("Remove…"),
    })[item];

  const activeAccount = snapshot.accounts.find((account) => account.active);
  const signedIn = snapshot.accounts.filter((account) => account.state === "ready");
  const nameOf = (id: string | null) =>
    snapshot.accounts.find((account) => account.id === id)?.name ?? "";
  const lastSwitch = snapshot.history[0];
  const switchAccounts = (entry: { readonly fromName: string | null; readonly toName: string }) =>
    entry.fromName ? `${entry.fromName} → ${entry.toName}` : entry.toName;
  const errorKey = snapshot.lastError?.at ?? null;

  if (!snapshot.supported && snapshot.accounts.length <= 1) {
    return (
      <SettingsSection id="claude-accounts" title={gt("Accounts")}>
        <Alert variant="info" className="m-3">
          {snapshot.unsupportedReason}
        </Alert>
        <ProviderAuthenticationSection
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          instanceId={instanceId}
          provider={provider}
          readOnly={readOnly}
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      id="claude-accounts"
      title={gt("Accounts")}
      headerAction={
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await outcome(
                await checkUsage({ environmentId, input: { instanceId, accountId: null } }),
                gt("Couldn't check usage"),
              );
              setChecking(false);
            }}
          >
            {checking ? <Spinner size="xs" /> : <RefreshCwIcon />}
            {checking ? gt("Checking…") : gt("Check usage")}
          </Button>
          {readOnly ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={flowActive}
              onClick={() => void signIn(PROVIDER_ACCOUNT_ADD_METHOD_ID)}
            >
              <PlusIcon />
              <T>Add account</T>
            </Button>
          )}
        </div>
      }
    >
      <p className="px-3 pb-2 text-xs text-muted-foreground sm:px-4">
        <T>
          One account is active at a time. It runs every Claude thread and Claude in terminals on
          this computer.
        </T>
      </p>
      {!snapshot.supported && snapshot.unsupportedReason ? (
        <Alert variant="info" className="mx-3 mb-2">
          {snapshot.unsupportedReason}
        </Alert>
      ) : null}
      {snapshot.lastError && dismissedError !== errorKey ? (
        <Alert variant="warning" className="mx-3 mb-2">
          <AlertTitle>
            {gt("The last switch failed: {reason}. {name} is still active.", {
              reason: snapshot.lastError.message,
              name: activeAccount?.name ?? "",
            })}
          </AlertTitle>
          <AlertAction>
            <Button size="xs" variant="ghost" onClick={() => setDismissedError(errorKey)}>
              <T>Dismiss</T>
            </Button>
          </AlertAction>
        </Alert>
      ) : !activeAccount && snapshot.accounts.length > 0 ? (
        <Alert variant="warning" className="mx-3 mb-2">
          <T>
            No account is active, so Claude threads can't run. Use one of your accounts or sign in.
          </T>
        </Alert>
      ) : snapshot.switching &&
        snapshot.switching.initiatorClientId !== providerAccountsClientId ? (
        <Alert variant="info" className="mx-3 mb-2">
          {gt("Switching to {name}…", { name: nameOf(snapshot.switching.toId) })}
        </Alert>
      ) : null}
      {snapshot.accounts.length === 0 && !showFlow(PROVIDER_ACCOUNT_ADD_METHOD_ID) && !addOpen ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              <T>No Claude account</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Sign in to run Claude threads.</T>
            </EmptyDescription>
          </EmptyHeader>
          {readOnly ? null : (
            <Button size="sm" onClick={() => void signIn(PROVIDER_ACCOUNT_ADD_METHOD_ID)}>
              <T>Sign in</T>
            </Button>
          )}
        </Empty>
      ) : (
        <SettingsGroup>
          {snapshot.accounts.map((account) => {
            const renewId = `${PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX}${account.id}`;
            const model = accountRowModel({
              account,
              snapshot,
              now,
              signingIn: accountFlow === renewId && flowActive,
              workingThreads: account.active
                ? accountSwitch.workingThreads(environmentId, instanceId)
                : 0,
              formatTime,
              resolve: m,
            });
            const dot = toneDot[model.tone];
            const actionLabel =
              model.action === "use"
                ? gt("Use")
                : model.action === "sign-in"
                  ? gt("Sign in")
                  : model.action === "sign-in-again"
                    ? gt("Sign in again")
                    : model.action === "cancel"
                      ? gt("Cancel")
                      : null;
            const actionDisabled =
              readOnly ||
              (model.action === "use" && snapshot.switching !== null) ||
              ((model.action === "sign-in" || model.action === "sign-in-again") && flowActive);
            return (
              <div
                key={account.id}
                className={cn(
                  "@container/account grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-3 sm:px-4",
                  account.active && "bg-foreground/[0.03]",
                )}
              >
                <AccountChip seed={account.id} label={account.name} className="size-7 text-2xs" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {renaming === account.id ? (
                      <div className="grid gap-1">
                        <DraftInput
                          nativeInput
                          size="sm"
                          autoFocus
                          className="w-full max-w-56"
                          maxLength={40}
                          aria-label={gt("Rename {name}", { name: account.name })}
                          value={account.name}
                          onCommit={async (next) => {
                            const trimmed = next.trim();
                            if (!trimmed || trimmed === account.name) return setRenaming(null);
                            const result = await rename({
                              environmentId,
                              input: { instanceId, accountId: account.id, name: trimmed },
                            });
                            if (result._tag === "Success") setRenaming(null);
                            else if (!isAtomCommandInterrupted(result)) {
                              const failure = squashAtomCommandFailure(result);
                              setRenameError(
                                failure instanceof Error ? failure.message : gt("Couldn't rename."),
                              );
                            }
                          }}
                        />
                        {renameError ? (
                          <p role="alert" className="text-xs text-destructive">
                            {renameError}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <span className="truncate text-sm font-medium">{account.name}</span>
                    )}
                    {account.active ? (
                      <Badge variant="success" size="sm">
                        <T>Active</T>
                      </Badge>
                    ) : null}
                    {account.plan ? (
                      <Badge variant="outline" size="sm">
                        {account.plan}
                      </Badge>
                    ) : null}
                    {account.organizationName && account.organizationKind !== "personal" ? (
                      <Badge variant="secondary" size="sm">
                        {account.organizationName}
                      </Badge>
                    ) : null}
                    {account.autoSwitch ? null : (
                      <Badge variant="outline" size="sm">
                        <T>Not in automatic switching</T>
                      </Badge>
                    )}
                  </div>
                  <div
                    aria-live="polite"
                    className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    {account.email ? (
                      <>
                        <RedactedSensitiveText
                          value={account.email}
                          ariaLabel={gt("Toggle account email visibility")}
                          revealTooltip={gt("Click to reveal email")}
                          hideTooltip={gt("Click to hide email")}
                          className="max-w-64 truncate"
                        />
                        <span aria-hidden>·</span>
                      </>
                    ) : null}
                    {model.tone === "busy" ? <Spinner size="xs" tone="muted" /> : null}
                    {dot ? <span aria-hidden className={cn("size-1.5 rounded-full", dot)} /> : null}
                    <span className={model.tone === "error" ? "text-destructive" : undefined}>
                      {model.status}
                    </span>
                    {model.signInEndsInDays !== null ? (
                      <span className="text-warning">
                        {model.signInEndsInDays === 0
                          ? gt("· sign-in ends today")
                          : gt(
                              "{count, plural, one {· sign-in ends in {count} day} other {· sign-in ends in {count} days}}",
                              {
                                count: model.signInEndsInDays,
                              },
                            )}
                      </span>
                    ) : null}
                    {model.usageStale && account.usageCheckedAt ? (
                      <span>
                        · {gt("checked {time}", { time: formatTime(account.usageCheckedAt) })}
                      </span>
                    ) : null}
                  </div>
                  {account.usageLimits && account.usageLimits.windows.length > 0 ? (
                    <div className={cn("mt-2 max-w-xl", model.usageStale && "opacity-60")}>
                      <LimitWindows
                        driver={provider.driver}
                        windows={account.usageLimits.windows}
                        now={now}
                        compact
                      />
                    </div>
                  ) : null}
                  {showFlow(renewId) ? (
                    <div className="mt-2">
                      <ProviderAuthenticationSection
                        environmentId={environmentId}
                        environmentLabel={environmentLabel}
                        instanceId={instanceId}
                        provider={provider}
                        readOnly={readOnly}
                        connection={{
                          id: renewId,
                          name: account.name,
                          description: null,
                          type: "connection",
                        }}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  {actionLabel ? (
                    <Button
                      size="xs"
                      variant={
                        model.action === "sign-in-again" && account.active ? "default" : "outline"
                      }
                      disabled={actionDisabled}
                      aria-label={`${actionLabel} ${account.name}`}
                      onClick={() => {
                        if (model.action === "use") requestUse(account);
                        else if (model.action === "cancel" && auth?.flowId)
                          void cancel({
                            environmentId,
                            input: { instanceId, flowId: auth.flowId },
                          });
                        else void signIn(renewId);
                      }}
                    >
                      {actionLabel}
                    </Button>
                  ) : null}
                  {readOnly || model.menu.length === 0 ? null : (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={gt("{name} options", { name: account.name })}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {model.menu
                          .filter((item) => item !== "remove")
                          .map((item) => (
                            <MenuItem
                              key={item}
                              disabled={item === "use" && snapshot.switching !== null}
                              onClick={() => void onMenu(account, item)}
                            >
                              {menuLabel(item)}
                            </MenuItem>
                          ))}
                        {model.menu.includes("remove") ? (
                          <>
                            <MenuSeparator />
                            <MenuItem
                              variant="destructive"
                              onClick={() => void onMenu(account, "remove")}
                            >
                              {menuLabel("remove")}
                            </MenuItem>
                          </>
                        ) : null}
                      </MenuPopup>
                    </Menu>
                  )}
                </div>
              </div>
            );
          })}
          {addOpen || showFlow(PROVIDER_ACCOUNT_ADD_METHOD_ID) ? (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-3 py-3 sm:px-4">
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground"
              >
                <PlusIcon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <T>New account</T>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <T>
                    Claude's page signs in the account your browser is using. To add a different
                    account, open the link in a private window.
                  </T>
                </p>
                <ProviderAuthenticationSection
                  environmentId={environmentId}
                  environmentLabel={environmentLabel}
                  instanceId={instanceId}
                  provider={provider}
                  readOnly={readOnly}
                  connection={{
                    id: PROVIDER_ACCOUNT_ADD_METHOD_ID,
                    name: gt("New account"),
                    description: null,
                    type: "connection",
                  }}
                />
                {flowActive ? null : (
                  <Button size="xs" variant="ghost" onClick={() => setAddOpen(false)}>
                    <T>Close</T>
                  </Button>
                )}
              </div>
            </div>
          ) : null}
          <SettingsRow
            title={gt("Switch accounts at usage limits")}
            description={gt(
              "When the active account runs out of usage, T3 moves every Claude thread to another signed-in account with room left and continues the stopped threads. This setting also applies to other providers' accounts.",
            )}
            status={
              <span className="flex flex-wrap items-center gap-1">
                {snapshot.autoSwitch.blockedReason === "paused" &&
                snapshot.autoSwitch.pausedUntil ? (
                  <span className="text-warning">
                    {gt("Automatic switching paused until {time}: 5 switches in an hour.", {
                      time: formatTime(snapshot.autoSwitch.pausedUntil),
                    })}{" "}
                    <Button
                      size="xs"
                      variant="link"
                      onClick={async () =>
                        outcome(
                          await resume({ environmentId, input: { instanceId } }),
                          gt("Couldn't resume"),
                        )
                      }
                    >
                      <T>Resume now</T>
                    </Button>
                  </span>
                ) : snapshot.autoSwitch.blockedReason === "one_account" || signedIn.length < 2 ? (
                  <T>Add another account to keep working when this one runs out of usage.</T>
                ) : snapshot.autoSwitch.targetId ? (
                  gt("Next: {name}.", { name: nameOf(snapshot.autoSwitch.targetId) })
                ) : (
                  <T>No other account has room left.</T>
                )}
                {lastSwitch ? (
                  <>
                    <span>
                      {gt("Last switch {time}: {accounts} ({reason})", {
                        time: formatTime(lastSwitch.at),
                        accounts: switchAccounts(lastSwitch),
                        reason: switchReasonText(lastSwitch, providerAccountsClientId, m),
                      })}
                    </span>
                    <Popover>
                      <PopoverTrigger render={<Button size="xs" variant="link" />}>
                        <T>History</T>
                      </PopoverTrigger>
                      <PopoverPopup align="start">
                        <div className="grid max-w-md gap-1.5 text-xs">
                          {snapshot.history.map((entry) => (
                            <div key={entry.at}>
                              {formatTime(entry.at)} · {switchAccounts(entry)}{" "}
                              <span className="text-muted-foreground">
                                · {switchReasonText(entry, providerAccountsClientId, m)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </PopoverPopup>
                    </Popover>
                  </>
                ) : null}
              </span>
            }
            control={
              <ScopedSwitch
                settingKeys={["switchAccountsAtUsageLimits"]}
                checked={switchEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ switchAccountsAtUsageLimits: Boolean(checked) })
                }
                aria-label={gt("Switch accounts at usage limits")}
              />
            }
          />
        </SettingsGroup>
      )}
      {accountSwitch.dialog}
    </SettingsSection>
  );
}
