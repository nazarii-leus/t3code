import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type {
  ProviderAccount,
  ProviderAccountSwitchEntry,
  ProviderAccountsSnapshot,
  ProviderMcpServer,
} from "@t3tools/contracts";

/** What a row of the account list shows and offers; web and mobile render the same table. */
export type AccountRowAction = "use" | "sign-in" | "sign-in-again" | "cancel" | null;
export type AccountMenuItem =
  | "use"
  | "check-usage"
  | "sign-in"
  | "sign-in-again"
  | "auto-switch-off"
  | "auto-switch-on"
  | "rename"
  | "copy-email"
  | "sign-out"
  | "remove";

export interface AccountRowModel {
  readonly status: string;
  readonly tone: "plain" | "muted" | "warning" | "error" | "busy";
  readonly action: AccountRowAction;
  readonly menu: ReadonlyArray<AccountMenuItem>;
  /** Days until the sign-in ends, when 5 or fewer. */
  readonly signInEndsInDays: number | null;
  readonly usageStale: boolean;
}

const DAY_MS = 86_400_000;
const STALE_MS = 30 * 60_000;

const exhaustedWindow = (account: ProviderAccount, now: number) =>
  account.usageLimits?.windows.find(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > now),
  );

export function accountRowModel(input: {
  readonly account: ProviderAccount;
  readonly snapshot: ProviderAccountsSnapshot;
  readonly now: number;
  /** A sign-in flow of this row is running. */
  readonly signingIn: boolean;
  /** Threads of this provider that are working right now. */
  readonly workingThreads: number;
  readonly formatTime: (iso: string) => string;
  readonly resolve?: MFunctionType;
}): AccountRowModel {
  const { account, snapshot, now } = input;
  const resolve = input.resolve ?? mFallback;
  const switching = snapshot.switching;
  const endsAt = account.signInEndsAt ? Date.parse(account.signInEndsAt) : Number.NaN;
  const days = Number.isFinite(endsAt) ? Math.max(0, Math.floor((endsAt - now) / DAY_MS)) : null;
  const signInEndsInDays = days !== null && days <= 5 ? days : null;
  const checkedAt = account.usageCheckedAt ? Date.parse(account.usageCheckedAt) : Number.NaN;
  const usageStale = Number.isFinite(checkedAt) && now - checkedAt > STALE_MS;
  const anotherReady = snapshot.accounts.some(
    (other) => other.id !== account.id && other.state === "ready",
  );
  const autoSwitchItem: AccountMenuItem = account.autoSwitch ? "auto-switch-off" : "auto-switch-on";
  const activeMenu: AccountMenuItem[] = [
    "check-usage",
    "sign-in-again",
    "rename",
    ...(account.email ? (["copy-email"] as const) : []),
    ...(anotherReady ? [] : (["sign-out"] as const)),
  ];
  const inactiveMenu: AccountMenuItem[] = [
    "use",
    "check-usage",
    "sign-in-again",
    autoSwitchItem,
    "rename",
    ...(account.email ? (["copy-email"] as const) : []),
    "remove",
  ];
  const ending = (menu: AccountMenuItem[]) =>
    signInEndsInDays === null
      ? menu
      : ["sign-in-again" as const, ...menu.filter((item) => item !== "sign-in-again")];
  const exhausted = exhaustedWindow(account, now);

  if (switching?.toId === account.id) {
    return {
      status: resolve(msg("Switching…")),
      tone: "busy",
      action: null,
      menu: [],
      signInEndsInDays,
      usageStale,
    };
  }
  if (switching?.fromId === account.id) {
    const to = snapshot.accounts.find((other) => other.id === switching.toId)?.name ?? "";
    return {
      status: resolve(msg("Switching to {name}…", { name: to })),
      tone: "busy",
      action: null,
      menu: [],
      signInEndsInDays,
      usageStale,
    };
  }
  if (input.signingIn) {
    return {
      status: resolve(msg("Finish signing in in your browser.")),
      tone: "busy",
      action: "cancel",
      menu: [],
      signInEndsInDays,
      usageStale,
    };
  }
  if (account.active) {
    if (account.state === "expired") {
      return {
        status: resolve(
          msg(
            "Sign-in expired. Claude threads can't run until you sign in again or use another account.",
          ),
        ),
        tone: "error",
        action: "sign-in-again",
        menu: [
          "check-usage",
          "rename",
          ...(account.email ? (["copy-email"] as const) : []),
          ...(anotherReady ? [] : (["sign-out"] as const)),
        ],
        signInEndsInDays,
        usageStale,
      };
    }
    if (exhausted) {
      return {
        status: exhausted.resetsAt
          ? resolve(
              msg("In use · out of usage, {window} resets {time}", {
                window: exhausted.label,
                time: input.formatTime(exhausted.resetsAt),
              }),
            )
          : resolve(msg("In use · out of usage, {window}", { window: exhausted.label })),
        tone: "warning",
        action: null,
        menu: ending(activeMenu),
        signInEndsInDays,
        usageStale,
      };
    }
    return {
      status:
        input.workingThreads > 0
          ? resolve(
              msg(
                "{count, plural, one {In use · {count} thread working} other {In use · {count} threads working}}",
                { count: input.workingThreads },
              ),
            )
          : resolve(msg("In use")),
      tone: "plain",
      action: null,
      menu: ending(activeMenu),
      signInEndsInDays,
      usageStale,
    };
  }
  if (account.state === "error") {
    return {
      status: resolve(
        msg("Something went wrong: {message}", { message: account.stateMessage ?? "" }),
      ),
      tone: "error",
      action: null,
      menu: [
        "check-usage",
        "sign-in-again",
        "rename",
        ...(account.email ? (["copy-email"] as const) : []),
        "remove",
      ],
      signInEndsInDays,
      usageStale,
    };
  }
  if (account.state === "signed-out") {
    return {
      status: resolve(msg("Signed out")),
      tone: "muted",
      action: "sign-in",
      menu: ["sign-in", "rename", "remove"],
      signInEndsInDays: null,
      usageStale: false,
    };
  }
  if (account.state === "expired") {
    return {
      status: resolve(msg("Sign-in expired")),
      tone: "warning",
      action: "sign-in-again",
      menu: ["sign-in-again", "rename", "remove"],
      signInEndsInDays: null,
      usageStale,
    };
  }
  const status = exhausted
    ? exhausted.resetsAt
      ? resolve(
          msg("Out of usage · {window} resets {time}", {
            window: exhausted.label,
            time: input.formatTime(exhausted.resetsAt),
          }),
        )
      : resolve(msg("Out of usage · {window}", { window: exhausted.label }))
    : account.usageError
      ? resolve(msg("Couldn't check usage: {error}", { error: account.usageError }))
      : !account.usageLimits
        ? resolve(msg("Usage not checked yet"))
        : resolve(msg("Ready"));
  return {
    status,
    tone: exhausted || account.usageError ? "warning" : "plain",
    action: snapshot.supported ? "use" : null,
    menu: ending(snapshot.supported ? inactiveMenu : inactiveMenu.filter((item) => item !== "use")),
    signInEndsInDays,
    usageStale,
  };
}

/** The lines of the confirm shown before a switch; empty means switch at once. */
export function switchConfirmLines(input: {
  readonly target: ProviderAccount;
  readonly workingThreads: number;
  /** Models that threads of this provider use right now. */
  readonly modelsInUse: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly threads: number;
  }>;
  readonly now: number;
  readonly formatTime: (iso: string) => string;
  readonly resolve?: MFunctionType;
}): ReadonlyArray<string> {
  const resolve = input.resolve ?? mFallback;
  const lines: string[] = [];
  if (input.workingThreads > 0) {
    lines.push(
      resolve(
        msg(
          "{count, plural, one {{count} Claude thread is working. It finishes its current step, then continues on {name}.} other {{count} Claude threads are working. Each finishes its current step, then continues on {name}.}}",
          { count: input.workingThreads, name: input.target.name },
        ),
      ),
    );
  }
  const models = input.target.models;
  for (const model of input.modelsInUse) {
    if (models && !models.includes(model.id)) {
      lines.push(
        resolve(
          msg(
            "{count, plural, one {{name} can't use {model}. {count} thread that uses it will stop with an error.} other {{name} can't use {model}. {count} threads that use it will stop with an error.}}",
            { count: model.threads, name: input.target.name, model: model.name },
          ),
        ),
      );
    }
  }
  const exhausted = exhaustedWindow(input.target, input.now);
  if (exhausted?.resetsAt) {
    lines.push(
      resolve(
        msg("{name} is out of usage until {time}.", {
          name: input.target.name,
          time: input.formatTime(exhausted.resetsAt),
        }),
      ),
    );
  }
  return lines;
}

/** The muted reason of one history entry. */
export function switchReasonText(
  entry: ProviderAccountSwitchEntry,
  ownClientId: string | null,
  resolve: MFunctionType = mFallback,
): string {
  const reason =
    entry.reason === "usage_limit"
      ? entry.window
        ? resolve(msg("out of usage: {window}", { window: entry.window }))
        : resolve(msg("out of usage"))
      : entry.reason === "sign_in"
        ? resolve(msg("new sign-in"))
        : entry.reason === "outside"
          ? resolve(msg("changed outside T3"))
          : resolve(msg("you switched"));
  const origin =
    entry.initiator.kind === "server"
      ? resolve(msg("automatically"))
      : entry.initiator.kind === "mobile"
        ? resolve(msg("from your phone"))
        : entry.initiator.clientId !== null && entry.initiator.clientId !== ownClientId
          ? resolve(msg("from another window"))
          : null;
  return origin ? `${reason} · ${origin}` : reason;
}

export type McpRowAction = "sign-in" | "retry" | "turn-on" | "cancel" | null;
export type McpMenuItem =
  | "check"
  | "reconnect"
  | "sign-in"
  | "sign-out"
  | "turn-off"
  | "turn-on"
  | "edit"
  | "copy"
  | "remove";

export interface McpRowModel {
  readonly status: string;
  readonly tone: "plain" | "muted" | "warning" | "error" | "success" | "busy";
  readonly action: McpRowAction;
  readonly menu: ReadonlyArray<McpMenuItem>;
  /** Why Edit and Remove are missing, for servers T3 cannot change. */
  readonly managedReason: string | null;
}

export function mcpServerRowModel(input: {
  readonly server: ProviderMcpServer;
  readonly projectPicked: boolean;
  readonly signingIn: boolean;
  readonly resolve?: MFunctionType;
}): McpRowModel {
  const { server } = input;
  const resolve = input.resolve ?? mFallback;
  const managedReason =
    server.scope === "plugin"
      ? resolve(
          msg("Comes from the plugin {plugin}. Turn the plugin off in Claude to remove it.", {
            plugin: server.scopeDetail ?? "",
          }),
        )
      : server.scope === "claudeai"
        ? resolve(msg("Managed on claude.ai for {name}.", { name: server.scopeDetail ?? "" }))
        : server.scope === "managed"
          ? resolve(msg("Set by your organization."))
          : null;
  const edit: McpMenuItem[] = server.canEdit ? ["edit"] : [];
  const remove: McpMenuItem[] = server.canRemove ? ["remove"] : [];
  const toggle = (item: McpMenuItem): McpMenuItem[] =>
    input.projectPicked && server.canToggle ? [item] : [];
  if (input.signingIn) {
    return {
      status: resolve(msg("Finish signing in in your browser.")),
      tone: "busy",
      action: "cancel",
      menu: [],
      managedReason,
    };
  }
  switch (server.state) {
    case "connected": {
      const count = server.tools?.length ?? 0;
      return {
        status: resolve(
          msg("{count, plural, one {Connected · {count} tool} other {Connected · {count} tools}}", {
            count,
          }),
        ),
        tone: "success",
        action: null,
        menu: [
          "check",
          "reconnect",
          ...(server.signedIn ? (["sign-out"] as const) : []),
          ...toggle("turn-off"),
          ...edit,
          "copy",
          ...remove,
        ],
        managedReason,
      };
    }
    case "needs-auth":
      return {
        status: resolve(msg("Sign-in needed")),
        tone: "warning",
        action: server.canSignIn ? "sign-in" : null,
        menu: [...(server.canSignIn ? (["sign-in"] as const) : []), ...edit, "copy", ...remove],
        managedReason,
      };
    case "failed":
      return {
        status: resolve(msg("Couldn't connect: {error}", { error: server.error ?? "" })),
        tone: "error",
        action: "retry",
        menu: ["check", ...edit, "copy", ...remove],
        managedReason,
      };
    case "disabled":
      return {
        status: resolve(msg("Off in this project")),
        tone: "muted",
        action: input.projectPicked ? "turn-on" : null,
        menu: [...toggle("turn-on"), ...edit, "copy", ...remove],
        managedReason,
      };
    default:
      return {
        status: resolve(msg("Not checked yet")),
        tone: "muted",
        action: null,
        menu: [
          "check",
          ...(server.signedIn ? (["sign-out"] as const) : []),
          ...edit,
          "copy",
          ...remove,
        ],
        managedReason,
      };
  }
}

/** Server keys whose server belongs in each group, in the order the section shows them. */
export function mcpServerGroups(servers: ReadonlyArray<ProviderMcpServer>) {
  const groups = [
    { id: "project", scopes: ["project", "local"] },
    { id: "user", scopes: ["user"] },
    { id: "plugin", scopes: ["plugin"] },
    { id: "claudeai", scopes: ["claudeai"] },
    { id: "managed", scopes: ["managed"] },
    { id: "other", scopes: ["other"] },
  ] as const;
  return groups
    .map((group) => ({
      id: group.id,
      servers: servers.filter((server) =>
        (group.scopes as ReadonlyArray<string>).includes(server.scope),
      ),
    }))
    .filter((group) => group.servers.length > 0);
}
