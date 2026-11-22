import {
  mcpGroupTitle,
  mcpMenuLabel,
  mcpServerGroups,
  mcpServerRowModel,
  type McpMenuItem,
} from "@t3tools/client-runtime/provider-accounts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_MCP_METHOD_PREFIX,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderMcpServer,
  type ProviderMcpServerInput,
  type ServerProvider,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import {
  EyeIcon,
  MoreVertical,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../../localApi";
import { cn, randomUUID } from "../../../lib/utils";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { commandSucceeded } from "./commandSucceeded";
import { Alert, AlertAction, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button, InlineButton } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "../../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { ProviderAuthenticationSection } from "../ProviderAuthenticationSection";
import { SecretInput } from "../SecretInput";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSection } from "../settingsLayout";

const COMMANDS = { reportFailure: false, reportDefect: false } as const;
const NAME = /^[A-Za-z0-9_-]+$/;
const toneDot: Record<string, string | null> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/60",
  plain: null,
  busy: null,
};

interface Pair {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  /** A stored value is kept unless replaced. */
  readonly stored: boolean;
}

interface Draft {
  readonly mode: "add" | "replace";
  readonly key: string | null;
  readonly scope: "user" | "local" | "project";
  readonly name: string;
  readonly transport: "http" | "sse" | "stdio";
  readonly url: string;
  readonly headers: ReadonlyArray<Pair>;
  readonly command: string;
  readonly args: string;
  readonly env: ReadonlyArray<Pair>;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackPort: string;
  readonly originalUrl: string | null;
  readonly originalTransport: string | null;
  readonly signedIn: boolean;
}

const emptyDraft: Draft = {
  mode: "add",
  key: null,
  scope: "user",
  name: "",
  transport: "http",
  url: "",
  headers: [],
  command: "",
  args: "",
  env: [],
  clientId: "",
  clientSecret: "",
  callbackPort: "",
  originalUrl: null,
  originalTransport: null,
  signedIn: false,
};

export function ProviderMcpSection({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  project,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly project: { readonly id: ProjectId; readonly name: string } | null;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const projectId = project?.id ?? null;
  const state = useEnvironmentQuery(
    serverEnvironment.providerMcpState({ environmentId, input: { instanceId, projectId } }),
    m,
  ).data;
  const auth = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
    m,
  ).data;
  const check = useAtomCommand(serverEnvironment.checkProviderMcp, COMMANDS);
  const getServer = useAtomCommand(serverEnvironment.getProviderMcpServer, COMMANDS);
  const save = useAtomCommand(serverEnvironment.saveProviderMcpServer, COMMANDS);
  const remove = useAtomCommand(serverEnvironment.removeProviderMcpServer, COMMANDS);
  const setEnabled = useAtomCommand(serverEnvironment.setProviderMcpServerEnabled, COMMANDS);
  const reconnect = useAtomCommand(serverEnvironment.reconnectProviderMcpServer, COMMANDS);
  const start = useAtomCommand(serverEnvironment.startProviderAuth, COMMANDS);
  const removeMethod = useAtomCommand(serverEnvironment.removeProviderAuthMethod, COMMANDS);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, COMMANDS);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set());
  const flowActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const flowKey = auth?.methodId?.startsWith(PROVIDER_MCP_METHOD_PREFIX)
    ? auth.methodId.slice(PROVIDER_MCP_METHOD_PREFIX.length)
    : null;

  const outcome = <A, E>(result: AtomCommandResult<A, E>, failureTitle: string) =>
    commandSucceeded(result, failureTitle, m);

  const target = (key: string) => ({ environmentId, input: { instanceId, projectId, key } });

  async function openEdit(server: ProviderMcpServer) {
    const result = await getServer(target(server.key));
    if (!outcome(result, gt("Couldn't read the server"))) return;
    const view = result.value;
    setSaveError(null);
    setDraft({
      ...emptyDraft,
      mode: "replace",
      key: server.key,
      scope: view.scope,
      name: view.name,
      transport: view.transport,
      url: view.url ?? "",
      headers: view.headerNames.map((name) => ({
        id: randomUUID(),
        name,
        value: "",
        stored: true,
      })),
      command: view.command ?? "",
      args: view.args.join("\n"),
      env: view.envNames.map((name) => ({ id: randomUUID(), name, value: "", stored: true })),
      clientId: view.oauthClientId ?? "",
      callbackPort: view.oauthCallbackPort?.toString() ?? "",
      originalUrl: view.url,
      originalTransport: view.transport,
      signedIn: server.signedIn === true,
    });
  }

  async function onMenu(server: ProviderMcpServer, item: McpMenuItem) {
    switch (item) {
      case "check":
        return outcome(await check(target(server.key)), gt("Couldn't check the server"));
      case "reconnect": {
        const result = await reconnect(target(server.key));
        if (outcome(result, gt("Couldn't reconnect"))) {
          toastManager.add({
            type: "success",
            title:
              result.value.reconnected === 0
                ? gt("No running threads")
                : gt(
                    "{count, plural, one {Reconnected {name} in {count} thread} other {Reconnected {name} in {count} threads}}",
                    {
                      count: result.value.reconnected,
                      name: server.name,
                    },
                  ),
          });
        }
        return;
      }
      case "sign-in":
        return outcome(
          await start({
            environmentId,
            input: { instanceId, methodId: `${PROVIDER_MCP_METHOD_PREFIX}${server.key}` },
          }),
          gt("Could not start sign-in"),
        );
      case "sign-out":
        return outcome(
          await removeMethod({
            environmentId,
            input: { instanceId, methodId: `${PROVIDER_MCP_METHOD_PREFIX}${server.key}` },
          }),
          gt("Couldn't sign out"),
        );
      case "turn-off":
      case "turn-on":
        if (!projectId) return;
        if (
          await outcome(
            await setEnabled({
              environmentId,
              input: { instanceId, projectId, key: server.key, enabled: item === "turn-on" },
            }),
            gt("Couldn't change the server"),
          )
        ) {
          toastManager.add({
            type: "success",
            title:
              item === "turn-on"
                ? gt("{name} is on in {project}", {
                    name: server.name,
                    project: project?.name ?? "",
                  })
                : gt("{name} is off in {project}", {
                    name: server.name,
                    project: project?.name ?? "",
                  }),
          });
        }
        return;
      case "edit":
        return openEdit(server);
      case "copy":
        await writeTextToClipboard(server.target);
        toastManager.add({ type: "success", title: gt("Address copied") });
        return;
      case "remove": {
        const where =
          server.scope === "project"
            ? gt(
                "Remove {name}? It's removed from .mcp.json in {project}. Commit the change to remove it for others.",
                {
                  name: server.name,
                  project: project?.name ?? "",
                },
              )
            : server.scope === "local"
              ? gt("Remove {name}? It's removed from {project} for you.", {
                  name: server.name,
                  project: project?.name ?? "",
                })
              : gt("Remove {name}? It's removed from all your projects.", { name: server.name });
        const message = server.signedIn ? `${where} ${gt("Its sign-in is deleted too.")}` : where;
        const confirmed = await ensureLocalApi().dialogs.confirm(message, {
          variant: "destructive",
        });
        if (
          confirmed &&
          (await outcome(await remove(target(server.key)), gt("Couldn't remove the server")))
        ) {
          toastManager.add({ type: "success", title: gt("Removed {name}", { name: server.name }) });
        }
        return;
      }
    }
  }

  const menuLabel = (item: McpMenuItem) => mcpMenuLabel(item, m);

  function validate(current: Draft) {
    if (current.mode === "add") {
      if (!current.name.trim()) return gt("Enter a name.");
      if (!NAME.test(current.name.trim())) return gt("Use only letters, digits, '-' and '_'.");
      if (
        state?.servers.some(
          (server) => server.name === current.name.trim() && server.scope === current.scope,
        )
      ) {
        return gt("{name} already exists here.", { name: current.name.trim() });
      }
    }
    if (current.transport === "stdio")
      return current.command.trim() ? null : gt("Enter a command.");
    const url = URL.parse(current.url.trim());
    return url && (url.protocol === "http:" || url.protocol === "https:")
      ? null
      : gt("Enter an http or https URL.");
  }

  async function submit() {
    if (!draft) return;
    const problem = validate(draft);
    if (problem) return setSaveError(problem);
    const pairs = (rows: ReadonlyArray<Pair>) =>
      rows
        .filter((row) => row.name.trim())
        .map((row) => ({
          name: row.name.trim(),
          value: row.value ? row.value : row.stored ? null : "",
        }));
    const input: ProviderMcpServerInput = {
      scope: draft.scope,
      name: draft.name.trim(),
      transport: draft.transport,
      ...(draft.transport === "stdio"
        ? {
            command: draft.command.trim(),
            args: draft.args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean),
            env: pairs(draft.env),
          }
        : {
            url: draft.url.trim(),
            headers: pairs(draft.headers),
            ...(draft.clientId || draft.clientSecret || draft.callbackPort
              ? {
                  oauth: {
                    ...(draft.clientId ? { clientId: draft.clientId } : {}),
                    ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
                    ...(Number(draft.callbackPort) > 0
                      ? { callbackPort: Number(draft.callbackPort) }
                      : {}),
                  },
                }
              : {}),
          }),
    };
    setSaving(true);
    setSaveError(null);
    const result = await save({
      environmentId,
      input: { instanceId, projectId, input, mode: draft.mode },
    });
    setSaving(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title:
          draft.mode === "add"
            ? gt("Added {name}", { name: input.name })
            : gt("Saved {name}", { name: input.name }),
      });
      setDraft(null);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setSaveError(
        failure instanceof Error ? failure.message : gt("Claude couldn't save the server."),
      );
    }
  }

  const activeName = provider.accounts?.accounts.find((account) => account.active)?.name ?? "";

  const groups = mcpServerGroups(state?.servers ?? []);
  const checkedAt = state?.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const addressChanged =
    draft?.mode === "replace" &&
    draft.signedIn &&
    (draft.url.trim() !== (draft.originalUrl ?? "") || draft.transport !== draft.originalTransport);

  return (
    <SettingsSection
      id="claude-mcp-servers"
      title={gt("MCP servers")}
      headerAction={
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={state?.checking}
            onClick={async () =>
              outcome(
                await check({ environmentId, input: { instanceId, projectId, key: null } }),
                gt("Couldn't check the servers"),
              )
            }
          >
            {state?.checking ? <Spinner size="xs" /> : <RefreshCwIcon />}
            {state?.checking
              ? gt("Checking…")
              : checkedAt
                ? gt("Checked {time}", { time: checkedAt })
                : gt("Not checked yet")}
          </Button>
          {readOnly ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => (setSaveError(null), setDraft({ ...emptyDraft }))}
            >
              <PlusIcon />
              <T>Add server</T>
            </Button>
          )}
        </div>
      }
    >
      <p className="px-3 pb-2 text-xs text-muted-foreground sm:px-4">
        <T>
          Shared by all accounts. Running threads keep their servers until their next start;
          Reconnect applies a sign-in to them now.
        </T>{" "}
        {project
          ? gt("Showing {project} and your own servers.", { project: project.name })
          : gt("Pick a project at the top of Settings to see its servers.")}
      </p>
      {state?.error ? (
        <Alert variant="warning" className="mx-3 mb-2">
          <AlertTitle>
            {gt("Couldn't check the servers: {error}", { error: state.error })}
          </AlertTitle>
          <AlertAction>
            <Button
              size="xs"
              variant="ghost"
              onClick={async () =>
                outcome(
                  await check({ environmentId, input: { instanceId, projectId, key: null } }),
                  gt("Couldn't check the servers"),
                )
              }
            >
              <T>Try again</T>
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {groups.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>
              <T>No MCP servers</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Add a server to give Claude more tools.</T>
            </EmptyDescription>
          </EmptyHeader>
          {readOnly ? null : (
            <Button size="sm" onClick={() => setDraft({ ...emptyDraft })}>
              <T>Add server</T>
            </Button>
          )}
        </Empty>
      ) : (
        <SettingsGroup>
          {groups.map((group) => (
            <div key={group.id}>
              <p className="px-3 pt-3 text-2xs uppercase tracking-wide text-muted-foreground sm:px-4">
                {mcpGroupTitle(group.id, activeName, m)}
              </p>
              {group.servers.map((server) => {
                const model = mcpServerRowModel({
                  server,
                  projectPicked: projectId !== null,
                  signingIn: flowKey === server.key && flowActive,
                  resolve: m,
                });
                const dot = toneDot[model.tone];
                const actionLabel =
                  model.action === "sign-in"
                    ? gt("Sign in")
                    : model.action === "retry"
                      ? gt("Retry")
                      : model.action === "turn-on"
                        ? gt("Turn on")
                        : model.action === "cancel"
                          ? gt("Cancel")
                          : null;
                const toolsOpen = openTools.has(server.key);
                const tools = server.tools ?? [];
                return (
                  <div
                    key={server.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 sm:px-4"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{server.name}</span>
                        <Badge variant="outline" size="sm">
                          {server.transport === "ws"
                            ? "WebSocket"
                            : server.transport === "stdio"
                              ? "stdio"
                              : server.transport.toUpperCase()}
                        </Badge>
                        {server.scope === "project" ? (
                          <Badge variant="outline" size="sm">
                            <T>Shared</T>
                          </Badge>
                        ) : server.scope === "local" ? (
                          <Badge variant="outline" size="sm">
                            <T>Only you</T>
                          </Badge>
                        ) : null}
                      </div>
                      <div
                        aria-live="polite"
                        className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                      >
                        {model.tone === "busy" || server.checking ? (
                          <Spinner size="xs" tone="muted" />
                        ) : null}
                        {dot ? (
                          <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
                        ) : null}
                        {server.state === "connected" && tools.length > 0 ? (
                          <InlineButton
                            aria-expanded={toolsOpen}
                            onClick={() =>
                              setOpenTools((current) => {
                                const next = new Set(current);
                                if (next.has(server.key)) next.delete(server.key);
                                else next.add(server.key);
                                return next;
                              })
                            }
                          >
                            {model.status}
                          </InlineButton>
                        ) : (
                          <span className={model.tone === "error" ? "text-destructive" : undefined}>
                            {model.status}
                          </span>
                        )}
                        {server.target ? (
                          <>
                            <span aria-hidden>·</span>
                            <Tooltip>
                              <TooltipTrigger
                                render={<span className="max-w-80 truncate font-mono text-2xs" />}
                              >
                                {server.target}
                              </TooltipTrigger>
                              <TooltipPopup>{server.target}</TooltipPopup>
                            </Tooltip>
                          </>
                        ) : null}
                        {server.envNames.length > 0 ? (
                          <span className="font-mono text-2xs">
                            · {gt("env: {names}", { names: server.envNames.join(", ") })}
                          </span>
                        ) : null}
                      </div>
                      {toolsOpen ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {tools.map((tool) => (
                            <span
                              key={tool.name}
                              className="inline-flex items-center gap-1 rounded border px-1.5 font-mono text-2xs text-muted-foreground"
                            >
                              {tool.name}
                              {tool.readOnly ? (
                                <EyeIcon aria-label={gt("Read-only")} className="size-3" />
                              ) : null}
                              {tool.destructive ? (
                                <TriangleAlertIcon
                                  aria-label={gt("Can change or delete data")}
                                  className="size-3 text-warning"
                                />
                              ) : null}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {flowKey === server.key && (flowActive || auth?.phase === "failed") ? (
                        <div className="mt-2">
                          <ProviderAuthenticationSection
                            environmentId={environmentId}
                            environmentLabel={environmentLabel}
                            instanceId={instanceId}
                            provider={provider}
                            readOnly={readOnly}
                            connection={{
                              id: `${PROVIDER_MCP_METHOD_PREFIX}${server.key}`,
                              name: server.name,
                              description: null,
                              type: "connection",
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      {actionLabel && !readOnly ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={(model.action === "sign-in" && flowActive) || server.checking}
                          aria-label={`${actionLabel} ${server.name}`}
                          onClick={() => {
                            if (model.action === "sign-in") void onMenu(server, "sign-in");
                            else if (model.action === "retry") void onMenu(server, "check");
                            else if (model.action === "turn-on") void onMenu(server, "turn-on");
                            else if (auth?.flowId)
                              void cancel({
                                environmentId,
                                input: { instanceId, flowId: auth.flowId },
                              });
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
                                aria-label={gt("{name} options", { name: server.name })}
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
                                  disabled={item === "sign-in" && flowActive}
                                  onClick={() => void onMenu(server, item)}
                                >
                                  {menuLabel(item)}
                                </MenuItem>
                              ))}
                            {model.managedReason ? (
                              <MenuItem disabled>{model.managedReason}</MenuItem>
                            ) : null}
                            {server.scope === "claudeai" ? (
                              <MenuItem
                                onClick={() =>
                                  void ensureLocalApi().shell.openExternal(
                                    "https://claude.ai/settings/connectors",
                                  )
                                }
                              >
                                <T>Open claude.ai connectors</T>
                              </MenuItem>
                            ) : null}
                            {model.menu.includes("remove") ? (
                              <>
                                <MenuSeparator />
                                <MenuItem
                                  variant="destructive"
                                  onClick={() => void onMenu(server, "remove")}
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
            </div>
          ))}
        </SettingsGroup>
      )}
      <p className="px-3 pt-2 text-xs text-muted-foreground sm:px-4">
        <T>T3 also adds its own server, t3-code, to every thread.</T>
      </p>
      <Dialog open={draft !== null} onOpenChange={(open) => (open ? null : setDraft(null))}>
        <DialogPopup>
          {draft ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {draft.mode === "add"
                    ? gt("Add MCP server")
                    : gt("Edit {name}", { name: draft.name })}
                </DialogTitle>
                <DialogDescription>
                  <T>Claude keeps it in its own settings. Threads started after this use it.</T>
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 px-6">
                {draft.mode === "add" ? (
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium">
                      <T>Name</T>
                    </span>
                    <Input
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                    <span className="text-xs text-muted-foreground">
                      <T>Letters, digits, '-' and '_'.</T>
                    </span>
                  </label>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    <T>To rename a server, remove it and add it again.</T>
                  </p>
                )}
                {draft.mode === "add" ? (
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium">
                      <T>Available in</T>
                    </span>
                    <Select
                      value={draft.scope}
                      onValueChange={(value) =>
                        setDraft({ ...draft, scope: value as Draft["scope"] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="user">{gt("All your projects")}</SelectItem>
                        {project ? (
                          <SelectItem value="local">
                            {gt("{project}, only you", { project: project.name })}
                          </SelectItem>
                        ) : null}
                        {project ? (
                          <SelectItem value="project">
                            {gt("{project}, shared with the team", { project: project.name })}
                          </SelectItem>
                        ) : null}
                      </SelectPopup>
                    </Select>
                    {draft.scope === "project" ? (
                      <span className="text-xs text-muted-foreground">
                        <T>
                          Writes .mcp.json in the project folder. Commit it to share the server.
                        </T>
                      </span>
                    ) : null}
                  </label>
                ) : null}
                <ToggleGroup
                  value={[draft.transport]}
                  onValueChange={(value) =>
                    value[0] && setDraft({ ...draft, transport: value[0] as Draft["transport"] })
                  }
                >
                  <ToggleGroupItem value="http">{gt("Remote (HTTP)")}</ToggleGroupItem>
                  <ToggleGroupItem value="sse">{gt("Remote (SSE)")}</ToggleGroupItem>
                  <ToggleGroupItem value="stdio">{gt("Local command")}</ToggleGroupItem>
                </ToggleGroup>
                {draft.transport === "stdio" ? (
                  <>
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">
                        <T>Command</T>
                      </span>
                      <Input
                        placeholder={gt("npx my-mcp-server", {
                          $context: "example command; keep the command as is",
                        })}
                        value={draft.command}
                        onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">
                        <T>Arguments</T>
                      </span>
                      <Textarea
                        value={draft.args}
                        onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                      />
                    </label>
                    <PairRows
                      label={gt("Environment variables")}
                      addLabel={gt("Add variable")}
                      rows={draft.env}
                      onChange={(env) => setDraft({ ...draft, env })}
                    />
                  </>
                ) : (
                  <>
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">
                        <T>URL</T>
                      </span>
                      <Input
                        placeholder="https://…"
                        value={draft.url}
                        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                      />
                    </label>
                    <PairRows
                      label={gt("Headers")}
                      addLabel={gt("Add header")}
                      rows={draft.headers}
                      onChange={(headers) => setDraft({ ...draft, headers })}
                    />
                    <p className="text-xs text-muted-foreground">
                      <T>Values stay on this computer and are never shown again.</T>
                    </p>
                    <Collapsible>
                      <CollapsibleTrigger className="text-xs text-muted-foreground">
                        <T>Sign-in options</T>
                      </CollapsibleTrigger>
                      <CollapsiblePanel>
                        <div className="grid gap-2 pt-2">
                          <Input
                            placeholder={gt("Client ID")}
                            value={draft.clientId}
                            onChange={(event) =>
                              setDraft({ ...draft, clientId: event.target.value })
                            }
                          />
                          <SecretInput
                            value={draft.clientSecret}
                            placeholder={gt("Client secret")}
                            onChange={(event) =>
                              setDraft({ ...draft, clientSecret: event.target.value })
                            }
                          />
                          <Input
                            inputMode="numeric"
                            placeholder={gt("Callback port")}
                            value={draft.callbackPort}
                            onChange={(event) =>
                              setDraft({ ...draft, callbackPort: event.target.value })
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            <T>Only for servers that need a pre-registered app.</T>
                          </span>
                        </div>
                      </CollapsiblePanel>
                    </Collapsible>
                  </>
                )}
                {addressChanged || (draft.mode === "replace" && draft.signedIn) ? (
                  <Alert variant="warning">
                    <T>Saving this server signs it out; sign in again after.</T>
                  </Alert>
                ) : null}
                {saveError ? (
                  <Alert variant="error" role="alert">
                    {gt("Claude couldn't save the server: {message}", { message: saveError })}
                  </Alert>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  <T>Cancel</T>
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? gt("Saving…") : draft.mode === "add" ? gt("Add server") : gt("Save")}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

function PairRows({
  label,
  addLabel,
  rows,
  onChange,
}: {
  readonly label: string;
  readonly addLabel: string;
  readonly rows: ReadonlyArray<Pair>;
  readonly onChange: (rows: ReadonlyArray<Pair>) => void;
}) {
  const gt = useGT();
  return (
    <div className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {rows.map((row, index) => (
        <div
          key={row.id}
          className="grid grid-cols-1 gap-1.5 @min-[28rem]:grid-cols-[1fr_1fr_auto]"
        >
          <Input
            value={row.name}
            placeholder={gt("Name")}
            onChange={(event) =>
              onChange(
                rows.map((other, at) =>
                  at === index ? { ...other, name: event.target.value } : other,
                ),
              )
            }
          />
          <SecretInput
            value={row.value}
            configured={row.stored && !row.value}
            placeholder={
              row.stored ? gt("Stored secret, enter a new value to replace") : gt("Value")
            }
            onChange={(event) =>
              onChange(
                rows.map((other, at) =>
                  at === index ? { ...other, value: event.target.value } : other,
                ),
              )
            }
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Remove {name}", { name: row.name || label })}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="link"
        className="justify-self-start"
        onClick={() =>
          onChange([...rows, { id: randomUUID(), name: "", value: "", stored: false }])
        }
      >
        {addLabel}
      </Button>
    </div>
  );
}
