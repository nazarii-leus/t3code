import { useAtomValue } from "@effect/atom-react";
import * as Clipboard from "expo-clipboard";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  accountMenuLabel,
  accountRowModel,
  autoSwitchStatusText,
  mcpGroupTitle,
  mcpMenuLabel,
  mcpServerGroups,
  mcpServerRowModel,
  switchAccountsText,
  switchReasonText,
  type AccountMenuItem,
  type McpMenuItem,
} from "@t3tools/client-runtime/provider-accounts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_ACCOUNT_ADD_METHOD_ID,
  PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX,
  PROVIDER_MCP_METHOD_PREFIX,
  type EnvironmentId,
  type ProjectId,
  type ProviderAccount,
  type ProviderInstanceId,
  type ProviderMcpServer,
  type ProviderMcpServerInput,
  type ServerProvider,
} from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { m } from "../../i18n/messages";
import { useNowMinuteMs } from "../../lib/clock";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { LimitWindowBars } from "../usage/UsageLimitsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  formatAccountTime,
  mobileAccountsClientId,
  useClaudeAccountSwitch,
} from "./useClaudeAccountSwitch";

const COMMANDS = { reportFailure: false, reportDefect: false } as const;
const ACTIVE_PHASES = new Set(["starting", "waiting", "verifying"]);

export function SettingsClaudeAccountsRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}>) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const { environmentId, instanceId } = route.params;
  const presentation = useAtomValue(environmentPresentations.presentationsWithProvidersAtom).get(
    environmentId,
  );
  const provider = presentation?.serverConfig?.providers.find(
    (candidate) => candidate.instanceId === instanceId,
  );
  const canManage = useAtomValue(
    serverEnvironment.switchProviderAccount.permissionAtom(environmentId),
  );
  const { projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const project = projectGroups
    .find((group) => group.key === selectedProjectKey)
    ?.members.find((member) => member.project.environmentId === environmentId)?.project;
  return (
    <SettingsScreen title={gt("Claude")}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!provider?.accounts ? (
          <Text className="text-foreground-muted">
            <T>Claude is not available on this environment.</T>
          </Text>
        ) : (
          <>
            <AccountsSection
              environmentId={environmentId}
              provider={provider}
              canManage={canManage}
              switchEnabled={
                presentation?.serverConfig?.settings.switchAccountsAtUsageLimits ?? false
              }
            />
            <McpSection
              environmentId={environmentId}
              provider={provider}
              canManage={canManage}
              project={project ? { id: project.id, name: project.title } : null}
            />
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function useRunner() {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    setError(null);
    const result = await command();
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, m) ?? failure.message)
          : gt("Something went wrong. Try again."),
      );
    }
    return false;
  }
  return { run, error };
}

function AccountsSection({
  environmentId,
  provider,
  canManage,
  switchEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly canManage: boolean;
  readonly switchEnabled: boolean;
}) {
  const gt = useGT();
  const snapshot = provider.accounts!;
  const instanceId = provider.instanceId;
  const auth = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  ).data;
  const start = useAtomCommand(serverEnvironment.startProviderAuth, COMMANDS);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, COMMANDS);
  const remove = useAtomCommand(serverEnvironment.removeProviderAccount, COMMANDS);
  const rename = useAtomCommand(serverEnvironment.renameProviderAccount, COMMANDS);
  const setAutoSwitch = useAtomCommand(serverEnvironment.setProviderAccountAutoSwitch, COMMANDS);
  const checkUsage = useAtomCommand(serverEnvironment.checkProviderAccountsUsage, COMMANDS);
  const resume = useAtomCommand(serverEnvironment.resumeProviderAccountsAutoSwitch, COMMANDS);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, COMMANDS);
  const accountSwitch = useClaudeAccountSwitch();
  const { run, error } = useRunner();
  const now = useNowMinuteMs();
  const flowActive = ACTIVE_PHASES.has(auth?.phase ?? "");
  const accountFlow = auth?.methodId?.startsWith("account:") ? auth.methodId : null;
  const activeAccount = snapshot.accounts.find((account) => account.active);
  const nameOf = (id: string | null) =>
    snapshot.accounts.find((account) => account.id === id)?.name ?? "";
  const signIn = (methodId: string) =>
    void run(() => start({ environmentId, input: { instanceId, methodId } }));

  const menuLabel = (item: AccountMenuItem) => accountMenuLabel(item, m);

  function onMenu(account: ProviderAccount, item: AccountMenuItem) {
    const target = { environmentId, input: { instanceId, accountId: account.id } };
    switch (item) {
      case "use":
        return accountSwitch.requestSwitch({ environmentId, provider, account });
      case "check-usage":
        return void run(() => checkUsage(target));
      case "sign-in":
      case "sign-in-again":
        return signIn(`${PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX}${account.id}`);
      case "auto-switch-off":
      case "auto-switch-on":
        return void run(() =>
          setAutoSwitch({
            environmentId,
            input: { ...target.input, enabled: item === "auto-switch-on" },
          }),
        );
      case "rename":
        return Dialog.prompt({
          title: gt("Rename {name}", { name: account.name }),
          initialValue: account.name,
          cancelText: gt("Cancel"),
          confirmText: gt("Save"),
          onConfirm: (value) => {
            const name = value.trim();
            if (name && name !== account.name) {
              void run(() => rename({ environmentId, input: { ...target.input, name } }));
            }
          },
        });
      case "copy-email":
        if (account.email) void Clipboard.setStringAsync(account.email);
        return;
      case "sign-out":
        return Dialog.confirm({
          title: gt("Sign out?"),
          message: gt(
            "Sign out of Claude on {environment}? This stops running threads that share this sign-in. Thread history is kept.",
            { environment: environmentId },
          ),
          cancelText: gt("Cancel"),
          confirmText: gt("Sign out"),
          destructive: true,
          onConfirm: () => void run(() => logout({ environmentId, input: { instanceId } })),
        });
      case "remove":
        return Dialog.confirm({
          title: gt("Remove {name}?", { name: account.name }),
          message: gt(
            "Remove {name} from T3? T3 signs it out on this computer. Threads and their history stay.",
            { name: account.name },
          ),
          cancelText: gt("Cancel"),
          confirmText: gt("Remove"),
          destructive: true,
          onConfirm: () => void run(() => remove(target)),
        });
    }
  }

  const banner =
    snapshot.lastError !== null
      ? gt("The last switch failed: {reason}. {name} is still active.", {
          reason: snapshot.lastError.message,
          name: activeAccount?.name ?? "",
        })
      : !activeAccount && snapshot.accounts.length > 0
        ? gt(
            "No account is active, so Claude threads can't run. Use one of your accounts or sign in.",
          )
        : snapshot.switching && snapshot.switching.initiatorClientId !== mobileAccountsClientId
          ? gt("Switching to {name}…", { name: nameOf(snapshot.switching.toId) })
          : null;
  const autoSwitchStatus = autoSwitchStatusText(snapshot, formatAccountTime, m);

  return (
    <>
      <SettingsSection title={gt("Accounts")}>
        <Text className="px-4 pt-3 text-sm text-foreground-muted">
          <T>
            One account is active at a time. It runs every Claude thread and Claude in terminals on
            the server.
          </T>
        </Text>
        {!snapshot.supported && snapshot.unsupportedReason ? (
          <View className="px-4 pt-3">
            <Notice message={snapshot.unsupportedReason} />
          </View>
        ) : null}
        {banner ? (
          <View className="px-4 pt-3">
            <Notice message={banner} />
          </View>
        ) : null}
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
            formatTime: formatAccountTime,
            resolve: m,
          });
          const actionLabel =
            model.action === "use"
              ? gt("Use")
              : model.action === "sign-in"
                ? gt("Sign in")
                : model.action === "sign-in-again"
                  ? gt("Sign in again")
                  : null;
          const menuActions: MenuAction[] = model.menu.map((item) => ({
            id: item,
            title: menuLabel(item),
            attributes: {
              destructive: item === "remove" || item === "sign-out",
              disabled: item === "use" && snapshot.switching !== null,
            },
          }));
          const subtitle = [account.active ? gt("Active") : null, account.plan, model.status]
            .filter(Boolean)
            .join(" · ");
          return (
            <View key={account.id} className="gap-2 border-t border-border-subtle px-4 py-3">
              <View className="flex-row items-center gap-3">
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text textRole="body" className="text-foreground" numberOfLines={1}>
                    {account.name}
                  </Text>
                  <Text
                    accessibilityLiveRegion="polite"
                    textRole="footnote"
                    className={
                      model.tone === "error" ? "text-danger-foreground" : "text-foreground-muted"
                    }
                  >
                    {subtitle}
                  </Text>
                </View>
                {canManage && actionLabel ? (
                  <ControlPill
                    variant="pill"
                    label={actionLabel}
                    accessibilityLabel={`${actionLabel} ${account.name}`}
                    disabled={
                      (model.action === "use" && snapshot.switching !== null) ||
                      (model.action !== "use" && flowActive)
                    }
                    onPress={() =>
                      model.action === "use"
                        ? accountSwitch.requestSwitch({ environmentId, provider, account })
                        : signIn(renewId)
                    }
                  />
                ) : null}
                {canManage && menuActions.length > 0 ? (
                  <Menu
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={gt("{name} options", { name: account.name })}
                    title={account.name}
                    actions={menuActions}
                    onPressAction={({ nativeEvent }) =>
                      onMenu(account, nativeEvent.event as AccountMenuItem)
                    }
                  >
                    <ControlPill
                      icon="ellipsis"
                      accessibilityLabel={gt("{name} options", { name: account.name })}
                    />
                  </Menu>
                ) : null}
              </View>
              {account.usageLimits && account.usageLimits.windows.length > 0 ? (
                <View className={model.usageStale ? "opacity-60" : undefined}>
                  <LimitWindowBars
                    driver={provider.driver}
                    windows={account.usageLimits.windows}
                    now={now}
                  />
                </View>
              ) : null}
              {accountFlow === renewId ? (
                <SignInFlow environmentId={environmentId} instanceId={instanceId} />
              ) : null}
            </View>
          );
        })}
        {canManage ? (
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="plus"
              label={gt("Add account")}
              description={gt(
                "Claude's page signs in the account your browser is using. To add a different account, open the link in a private window.",
              )}
              disabled={flowActive}
              onPress={() => signIn(PROVIDER_ACCOUNT_ADD_METHOD_ID)}
            />
            {accountFlow === PROVIDER_ACCOUNT_ADD_METHOD_ID ? (
              <View className="px-4 pb-3">
                <SignInFlow environmentId={environmentId} instanceId={instanceId} />
              </View>
            ) : null}
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </SettingsSection>
      <SettingsSection title={gt("Switch accounts at usage limits")}>
        <SettingsSwitchRow
          icon="arrow.left.arrow.right"
          label={gt("Switch accounts at usage limits")}
          subtitle={gt(
            "When the active account runs out of usage, T3 moves every Claude thread to another signed-in account with room left and continues the stopped threads. This setting also applies to other providers' accounts.",
          )}
          value={switchEnabled}
          disabled={!canManage}
          onValueChange={(value) =>
            void run(() =>
              updateSettings({
                environmentId,
                input: { patch: { switchAccountsAtUsageLimits: value } },
              }),
            )
          }
        />
        <View className="gap-1 border-t border-border-subtle px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {autoSwitchStatus}
          </Text>
          {snapshot.autoSwitch.blockedReason === "paused" && canManage ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void run(() => resume({ environmentId, input: { instanceId } }))}
            >
              <Text className="text-sm font-t3-medium text-primary">
                <T>Resume now</T>
              </Text>
            </Pressable>
          ) : null}
          {snapshot.history.length === 0 ? (
            <Text textRole="footnote" className="text-foreground-muted">
              <T>No switches yet.</T>
            </Text>
          ) : (
            snapshot.history.slice(0, 20).map((entry) => (
              <Text key={entry.at} textRole="footnote" className="text-foreground-muted">
                {formatAccountTime(entry.at)} · {switchAccountsText(entry)} ·{" "}
                {switchReasonText(entry, mobileAccountsClientId, m)}
              </Text>
            ))
          )}
        </View>
      </SettingsSection>
    </>
  );
}

/** The running sign-in of the instance: open the page, paste the final URL, or cancel. */
function SignInFlow({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const gt = useGT();
  const auth = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  ).data;
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, COMMANDS);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, COMMANDS);
  const { run, error } = useRunner();
  const [callback, setCallback] = useState("");
  const interaction = auth?.interaction;
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : auth?.authorizationUrl;
  const active = ACTIVE_PHASES.has(auth?.phase ?? "");
  const flowId = auth?.flowId;
  return (
    <View className="gap-2">
      {auth?.message ? (
        <Text
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className={auth.phase === "failed" ? "text-danger-foreground" : "text-foreground-muted"}
        >
          {auth.message}
        </Text>
      ) : null}
      {url && active ? (
        <ListActionRow
          icon="globe"
          label={gt("Open sign-in page")}
          onPress={() => void Linking.openURL(url).catch(() => undefined)}
        />
      ) : null}
      {url && active && flowId ? (
        <>
          <TextInput
            accessibilityLabel={gt("Final localhost URL")}
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={gt("Final localhost URL")}
            autoCapitalize="none"
            autoCorrect={false}
            value={callback}
            onChangeText={setCallback}
          />
          <View className="flex-row justify-end gap-2">
            <ControlPill
              variant="pill"
              label={gt("Cancel")}
              onPress={() =>
                void run(() => cancel({ environmentId, input: { instanceId, flowId } }))
              }
            />
            <ControlPill
              variant="primary"
              label={gt("Continue")}
              disabled={!callback.trim()}
              onPress={() =>
                void run(() =>
                  complete({
                    environmentId,
                    input: { instanceId, flowId, callbackUrl: callback.trim() },
                  }),
                ).then((sent) => {
                  if (sent) setCallback("");
                })
              }
            />
          </View>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

interface McpDraft {
  readonly mode: "add" | "replace";
  readonly key: string | null;
  readonly scope: "user" | "local" | "project";
  readonly name: string;
  readonly transport: "http" | "sse" | "stdio";
  readonly url: string;
  readonly command: string;
  readonly args: string;
  /** Stored on the server; an edit keeps them (null values), since this form can't show them. */
  readonly headerNames: ReadonlyArray<string>;
  readonly envNames: ReadonlyArray<string>;
  readonly oauth: { readonly clientId?: string; readonly callbackPort?: number } | null;
}

const EMPTY_DRAFT: McpDraft = {
  mode: "add",
  key: null,
  scope: "user",
  name: "",
  transport: "http",
  url: "",
  command: "",
  args: "",
  headerNames: [],
  envNames: [],
  oauth: null,
};

function McpSection({
  environmentId,
  provider,
  canManage,
  project,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly canManage: boolean;
  readonly project: { readonly id: ProjectId; readonly name: string } | null;
}) {
  const gt = useGT();
  const instanceId = provider.instanceId;
  const projectId = project?.id ?? null;
  const state = useEnvironmentQuery(
    serverEnvironment.providerMcpState({ environmentId, input: { instanceId, projectId } }),
  ).data;
  const auth = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  ).data;
  const check = useAtomCommand(serverEnvironment.checkProviderMcp, COMMANDS);
  const getServer = useAtomCommand(serverEnvironment.getProviderMcpServer, COMMANDS);
  const save = useAtomCommand(serverEnvironment.saveProviderMcpServer, COMMANDS);
  const remove = useAtomCommand(serverEnvironment.removeProviderMcpServer, COMMANDS);
  const setEnabled = useAtomCommand(serverEnvironment.setProviderMcpServerEnabled, COMMANDS);
  const reconnect = useAtomCommand(serverEnvironment.reconnectProviderMcpServer, COMMANDS);
  const start = useAtomCommand(serverEnvironment.startProviderAuth, COMMANDS);
  const removeMethod = useAtomCommand(serverEnvironment.removeProviderAuthMethod, COMMANDS);
  const { run, error } = useRunner();
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const flowActive = ACTIVE_PHASES.has(auth?.phase ?? "");
  const flowKey = auth?.methodId?.startsWith(PROVIDER_MCP_METHOD_PREFIX)
    ? auth.methodId.slice(PROVIDER_MCP_METHOD_PREFIX.length)
    : null;
  const target = (key: string) => ({ environmentId, input: { instanceId, projectId, key } });
  const activeName = provider.accounts?.accounts.find((account) => account.active)?.name ?? "";

  const menuLabel = (item: McpMenuItem) => mcpMenuLabel(item, m);

  async function openEdit(server: ProviderMcpServer) {
    const result = await getServer(target(server.key));
    if (result._tag !== "Success") return;
    const view = result.value;
    setDraft({
      mode: "replace",
      key: server.key,
      scope: view.scope,
      name: view.name,
      transport: view.transport,
      url: view.url ?? "",
      command: view.command ?? "",
      args: view.args.join("\n"),
      headerNames: view.headerNames,
      envNames: view.envNames,
      oauth:
        view.oauthClientId || view.oauthCallbackPort
          ? {
              ...(view.oauthClientId ? { clientId: view.oauthClientId } : {}),
              ...(view.oauthCallbackPort ? { callbackPort: view.oauthCallbackPort } : {}),
            }
          : null,
    });
  }

  function onMenu(server: ProviderMcpServer, item: McpMenuItem) {
    const methodId = `${PROVIDER_MCP_METHOD_PREFIX}${server.key}`;
    switch (item) {
      case "check":
        return void run(() => check(target(server.key)));
      case "reconnect":
        return void run(() => reconnect(target(server.key)));
      case "sign-in":
        return void run(() => start({ environmentId, input: { instanceId, methodId } }));
      case "sign-out":
        return void run(() => removeMethod({ environmentId, input: { instanceId, methodId } }));
      case "turn-off":
      case "turn-on":
        if (!projectId) return;
        return void run(() =>
          setEnabled({
            environmentId,
            input: { instanceId, projectId, key: server.key, enabled: item === "turn-on" },
          }),
        );
      case "edit":
        return void openEdit(server);
      case "copy":
        void Clipboard.setStringAsync(server.target);
        return;
      case "remove":
        return Dialog.confirm({
          title: gt("Remove {name}?", { name: server.name }),
          message:
            server.scope === "project"
              ? gt(
                  "It's removed from .mcp.json in {project}. Commit the change to remove it for others.",
                  { project: project?.name ?? "" },
                )
              : server.scope === "local"
                ? gt("It's removed from {project} for you.", { project: project?.name ?? "" })
                : gt("It's removed from all your projects."),
          cancelText: gt("Cancel"),
          confirmText: gt("Remove"),
          destructive: true,
          onConfirm: () => void run(() => remove(target(server.key))),
        });
    }
  }

  function submit(current: McpDraft) {
    const name = current.name.trim();
    if (current.mode === "add" && !/^[A-Za-z0-9_-]+$/.test(name)) {
      return Dialog.alert(gt("Add MCP server"), gt("Use only letters, digits, '-' and '_'."));
    }
    const url = URL.parse(current.url.trim());
    if (current.transport !== "stdio" && !(url && /^https?:$/.test(url.protocol))) {
      return Dialog.alert(gt("Add MCP server"), gt("Enter an http or https URL."));
    }
    if (current.transport === "stdio" && !current.command.trim()) {
      return Dialog.alert(gt("Add MCP server"), gt("Enter a command."));
    }
    const input: ProviderMcpServerInput =
      current.transport === "stdio"
        ? {
            scope: current.scope,
            name,
            transport: "stdio",
            command: current.command.trim(),
            args: current.args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean),
            env: current.envNames.map((envName) => ({ name: envName, value: null })),
          }
        : {
            scope: current.scope,
            name,
            transport: current.transport,
            url: current.url.trim(),
            headers: current.headerNames.map((header) => ({ name: header, value: null })),
            ...(current.oauth ? { oauth: current.oauth } : {}),
          };
    void run(() =>
      save({ environmentId, input: { instanceId, projectId, input, mode: current.mode } }),
    ).then((saved) => {
      if (saved) setDraft(null);
    });
  }

  const groups = mcpServerGroups(state?.servers ?? []);
  return (
    <SettingsSection title={gt("MCP servers")}>
      <Text className="px-4 pt-3 text-sm text-foreground-muted">
        {project
          ? gt("Shared by all accounts. Showing {project} and your own servers.", {
              project: project.name,
            })
          : gt("Shared by all accounts. Pick a project in the settings filter to see its servers.")}
      </Text>
      {state?.error ? (
        <View className="px-4 pt-3">
          <Notice message={gt("Couldn't check the servers: {error}", { error: state.error })} />
        </View>
      ) : null}
      {groups.length === 0 ? (
        <Text className="px-4 py-3 text-foreground-muted">
          <T>No MCP servers</T>
        </Text>
      ) : null}
      {groups.map((group) => (
        <View key={group.id}>
          <Text className="px-4 pt-3 text-xs uppercase text-foreground-muted">
            {mcpGroupTitle(group.id, activeName, m)}
          </Text>
          {group.servers.map((server) => {
            const model = mcpServerRowModel({
              server,
              projectPicked: projectId !== null,
              signingIn: flowKey === server.key && flowActive,
              resolve: m,
            });
            const actionLabel =
              model.action === "sign-in"
                ? gt("Sign in")
                : model.action === "retry"
                  ? gt("Retry")
                  : model.action === "turn-on"
                    ? gt("Turn on")
                    : null;
            const actions: MenuAction[] = [
              ...model.menu.map((item) => ({
                id: item,
                title: menuLabel(item),
                attributes: {
                  destructive: item === "remove",
                  disabled: item === "sign-in" && flowActive,
                },
              })),
              ...(model.managedReason
                ? [{ id: "managed", title: model.managedReason, attributes: { disabled: true } }]
                : []),
            ];
            return (
              <View key={server.key} className="gap-2 border-t border-border-subtle px-4 py-3">
                <View className="flex-row items-center gap-3">
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text textRole="body" className="text-foreground" numberOfLines={1}>
                      {server.name}
                    </Text>
                    <Text
                      accessibilityLiveRegion="polite"
                      textRole="footnote"
                      className={
                        model.tone === "error" ? "text-danger-foreground" : "text-foreground-muted"
                      }
                      numberOfLines={2}
                    >
                      {[model.status, server.target].filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                  {canManage && actionLabel ? (
                    <ControlPill
                      variant="pill"
                      label={actionLabel}
                      accessibilityLabel={`${actionLabel} ${server.name}`}
                      disabled={server.checking || (model.action === "sign-in" && flowActive)}
                      onPress={() =>
                        onMenu(
                          server,
                          model.action === "retry"
                            ? "check"
                            : model.action === "turn-on"
                              ? "turn-on"
                              : "sign-in",
                        )
                      }
                    />
                  ) : null}
                  {canManage && actions.length > 0 ? (
                    <Menu
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={gt("{name} options", { name: server.name })}
                      title={server.name}
                      actions={actions}
                      onPressAction={({ nativeEvent }) => {
                        if (nativeEvent.event !== "managed") {
                          onMenu(server, nativeEvent.event as McpMenuItem);
                        }
                      }}
                    >
                      <ControlPill
                        icon="ellipsis"
                        accessibilityLabel={gt("{name} options", { name: server.name })}
                      />
                    </Menu>
                  ) : null}
                </View>
                {flowKey === server.key ? (
                  <SignInFlow environmentId={environmentId} instanceId={instanceId} />
                ) : null}
                {draft?.key === server.key ? (
                  <McpForm
                    draft={draft}
                    project={project}
                    onChange={setDraft}
                    onSubmit={submit}
                    onCancel={() => setDraft(null)}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
      <View className="border-t border-border-subtle">
        <ListActionRow
          icon="arrow.clockwise"
          label={gt("Check servers")}
          loading={state?.checking ?? false}
          onPress={() =>
            void run(() => check({ environmentId, input: { instanceId, projectId, key: null } }))
          }
        />
      </View>
      {canManage ? (
        <View className="border-t border-border-subtle">
          {draft?.mode === "add" ? (
            <View className="px-4 py-3">
              <McpForm
                draft={draft}
                project={project}
                onChange={setDraft}
                onSubmit={submit}
                onCancel={() => setDraft(null)}
              />
            </View>
          ) : (
            <ListActionRow
              icon="plus"
              label={gt("Add server")}
              onPress={() => setDraft(EMPTY_DRAFT)}
            />
          )}
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Text className="px-4 py-3 text-xs text-foreground-muted">
        <T>T3 also adds its own server, t3-code, to every thread.</T>
      </Text>
    </SettingsSection>
  );
}

/** Add or edit a server. Headers and environment values are set in web or desktop Settings. */
function McpForm({
  draft,
  project,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly draft: McpDraft;
  readonly project: { readonly name: string } | null;
  readonly onChange: (draft: McpDraft) => void;
  readonly onSubmit: (draft: McpDraft) => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const field = (key: "name" | "url" | "command" | "args", label: string) => (
    <TextInput
      accessibilityLabel={label}
      className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
      placeholderTextColorClassName="accent-foreground-muted"
      placeholder={label}
      autoCapitalize="none"
      autoCorrect={false}
      multiline={key === "args"}
      value={draft[key]}
      onChangeText={(value) => onChange({ ...draft, [key]: value })}
    />
  );
  const choice = <K extends "scope" | "transport">(
    key: K,
    options: ReadonlyArray<{ readonly value: McpDraft[K]; readonly label: string }>,
  ) => (
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => (
        <ControlPill
          key={option.value}
          variant={draft[key] === option.value ? "primary" : "pill"}
          label={option.label}
          onPress={() => onChange({ ...draft, [key]: option.value })}
        />
      ))}
    </View>
  );
  return (
    <View className="gap-2">
      {draft.mode === "add" ? (
        <>
          {field("name", gt("Name"))}
          {choice("scope", [
            { value: "user", label: gt("All your projects") },
            ...(project
              ? [
                  {
                    value: "local" as const,
                    label: gt("{project}, only you", { project: project.name }),
                  },
                  {
                    value: "project" as const,
                    label: gt("{project}, shared with the team", { project: project.name }),
                  },
                ]
              : []),
          ])}
        </>
      ) : (
        <Text textRole="footnote" className="text-foreground-muted">
          <T>To rename a server, remove it and add it again.</T>
        </Text>
      )}
      {choice("transport", [
        { value: "http", label: gt("Remote (HTTP)") },
        { value: "sse", label: gt("Remote (SSE)") },
        { value: "stdio", label: gt("Local command") },
      ])}
      {draft.transport === "stdio" ? (
        <>
          {field("command", gt("Command"))}
          {field("args", gt("Arguments, one per line"))}
        </>
      ) : (
        field("url", gt("URL"))
      )}
      <Text textRole="footnote" className="text-foreground-muted">
        <T>Headers, environment values and sign-in options are set in web or desktop Settings.</T>
      </Text>
      <View className="flex-row justify-end gap-2">
        <ControlPill variant="pill" label={gt("Cancel")} onPress={onCancel} />
        <ControlPill
          variant="primary"
          label={draft.mode === "add" ? gt("Add server") : gt("Save")}
          onPress={() => onSubmit(draft)}
        />
      </View>
    </View>
  );
}
