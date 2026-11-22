import { describe, expect, it } from "vite-plus/test";
import type {
  ProviderAccount,
  ProviderAccountsSnapshot,
  ProviderMcpServer,
} from "@t3tools/contracts";

import {
  accountRowModel,
  autoSwitchStatusText,
  mcpServerRowModel,
  switchConfirmLines,
  switchReasonText,
} from "./providerAccounts.ts";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const account = (overrides: Partial<ProviderAccount>): ProviderAccount => ({
  id: "a",
  name: "Max 20x",
  email: "a@example.com",
  organizationUuid: "o",
  organizationName: null,
  organizationKind: "personal",
  plan: "Max 20x",
  active: false,
  state: "ready",
  stateMessage: null,
  signInEndsAt: "2026-12-19T00:00:00.000Z",
  autoSwitch: true,
  models: ["claude-fable-5-2"],
  usageLimits: {
    checkedAt: "2026-11-21T11:59:00.000Z",
    windows: [{ id: "five_hour", kind: "session", label: "5-hour", usedPercent: 40 }],
  },
  usageCheckedAt: "2026-11-21T11:59:00.000Z",
  usageError: null,
  ...overrides,
});
const snapshot = (
  accounts: ProviderAccount[],
  overrides: Partial<ProviderAccountsSnapshot> = {},
): ProviderAccountsSnapshot => ({
  supported: true,
  unsupportedReason: null,
  accounts,
  switching: null,
  lastError: null,
  autoSwitch: { targetId: null, blockedReason: null, pausedUntil: null },
  history: [],
  ...overrides,
});
const row = (
  target: ProviderAccount,
  others: ProviderAccount[] = [],
  extra: Partial<Parameters<typeof accountRowModel>[0]> = {},
) =>
  accountRowModel({
    account: target,
    snapshot: snapshot([target, ...others]),
    now: NOW,
    signingIn: false,
    workingThreads: 0,
    formatTime: (iso) => iso.slice(11, 16),
    ...extra,
  });

describe("accountRowModel", () => {
  const other = account({ id: "b", name: "Team", active: false });
  it.each([
    [
      "active",
      account({ active: true }),
      [other],
      {
        status: "In use",
        tone: "plain",
        action: null,
        menu: ["check-usage", "sign-in-again", "rename", "copy-email"],
      },
    ],
    [
      "active, no other ready",
      account({ active: true }),
      [],
      {
        status: "In use",
        action: null,
        menu: ["check-usage", "sign-in-again", "rename", "copy-email", "sign-out"],
      },
    ],
    [
      "active, expired",
      account({ active: true, state: "expired" }),
      [other],
      { tone: "error", action: "sign-in-again" },
    ],
    [
      "active, out",
      account({
        active: true,
        usageLimits: {
          checkedAt: "x",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "5-hour",
              usedPercent: 100,
              resetsAt: "2026-11-21T14:10:00.000Z",
            },
          ],
        },
      }),
      [other],
      { status: "In use · out of usage, 5-hour resets 14:10", tone: "warning", action: null },
    ],
    [
      "ready",
      account({}),
      [],
      {
        status: "Ready",
        action: "use",
        menu: [
          "use",
          "check-usage",
          "sign-in-again",
          "auto-switch-off",
          "rename",
          "copy-email",
          "remove",
        ],
      },
    ],
    [
      "not in auto switch",
      account({ autoSwitch: false }),
      [],
      {
        menu: [
          "use",
          "check-usage",
          "sign-in-again",
          "auto-switch-on",
          "rename",
          "copy-email",
          "remove",
        ],
      },
    ],
    [
      "usage unknown",
      account({ usageLimits: null }),
      [],
      { status: "Usage not checked yet", action: "use" },
    ],
    [
      "usage error",
      account({ usageError: "timeout" }),
      [],
      { status: "Couldn't check usage: timeout", tone: "warning" },
    ],
    [
      "signed out",
      account({ state: "signed-out" }),
      [],
      {
        status: "Signed out",
        tone: "muted",
        action: "sign-in",
        menu: ["sign-in", "rename", "remove"],
      },
    ],
    [
      "expired",
      account({ state: "expired" }),
      [],
      {
        status: "Sign-in expired",
        action: "sign-in-again",
        menu: ["sign-in-again", "rename", "remove"],
      },
    ],
    [
      "error",
      account({ state: "error", stateMessage: "broken" }),
      [],
      { status: "Something went wrong: broken", tone: "error", action: null },
    ],
  ] as const)("%s", (_name, target, others, expected) => {
    expect(row(target, [...others])).toMatchObject(expected);
  });

  it("puts Sign in again first when the sign-in ends within 5 days", () => {
    const model = row(account({ signInEndsAt: "2026-11-24T13:00:00.000Z" }));
    expect(model.signInEndsInDays).toBe(3);
    expect(model.menu[0]).toBe("sign-in-again");
  });

  it("shows the switch on both rows and offers nothing during it", () => {
    const from = account({ id: "a", active: true });
    const to = account({ id: "b", name: "Team" });
    const state = snapshot([from, to], {
      switching: { fromId: "a", toId: "b", startedAt: "x", initiatorClientId: null },
    });
    const model = (target: ProviderAccount) =>
      accountRowModel({
        account: target,
        snapshot: state,
        now: NOW,
        signingIn: false,
        workingThreads: 0,
        formatTime: String,
      });
    expect(model(from)).toMatchObject({ status: "Switching to Team…", action: null, menu: [] });
    expect(model(to)).toMatchObject({ status: "Switching…", action: null, menu: [] });
  });

  it("offers no Use where switching is not supported", () => {
    const model = accountRowModel({
      account: account({}),
      snapshot: snapshot([account({})], { supported: false }),
      now: NOW,
      signingIn: false,
      workingThreads: 0,
      formatTime: String,
    });
    expect(model.action).toBeNull();
    expect(model.menu).not.toContain("use");
  });
});

describe("switchConfirmLines", () => {
  it("names working threads, a missing model and an exhausted target; nothing otherwise", () => {
    const target = account({
      name: "Team",
      models: ["claude-sonnet-5-5"],
      usageLimits: {
        checkedAt: "x",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "5-hour",
            usedPercent: 100,
            resetsAt: "2026-11-21T13:00:00.000Z",
          },
        ],
      },
    });
    expect(
      switchConfirmLines({
        target,
        workingThreads: 2,
        modelsInUse: [{ id: "claude-fable-5-2", name: "Fable 5.2", threads: 1 }],
        now: NOW,
        formatTime: (iso) => iso.slice(11, 16),
      }),
    ).toEqual([
      "2 Claude threads are working. Each finishes its current step, then continues on Team.",
      "Team can't use Fable 5.2. 1 thread that uses it will stop with an error.",
      "Team is out of usage until 13:00.",
    ]);
    expect(
      switchConfirmLines({
        target: account({}),
        workingThreads: 0,
        modelsInUse: [],
        now: NOW,
        formatTime: String,
      }),
    ).toEqual([]);
  });
});

describe("autoSwitchStatusText", () => {
  const a = account({ id: "a", active: true });
  const b = account({ id: "b", name: "Team" });
  it.each([
    [
      "names the next account",
      snapshot([a, b], { autoSwitch: { targetId: "b", blockedReason: null, pausedUntil: null } }),
      "Next: Team.",
    ],
    ["has no room left", snapshot([a, b]), "No other account has room left."],
    [
      "has one account",
      snapshot([a]),
      "Add another account to keep working when this one runs out of usage.",
    ],
    [
      "is paused",
      snapshot([a, b], {
        autoSwitch: {
          targetId: "b",
          blockedReason: "paused",
          pausedUntil: "2026-11-21T13:00:00.000Z",
        },
      }),
      "Automatic switching paused until 13:00: 5 switches in an hour.",
    ],
  ] as const)("%s", (_name, value, expected) => {
    expect(autoSwitchStatusText(value, (iso) => iso.slice(11, 16))).toBe(expected);
  });
});

describe("switchReasonText", () => {
  const entry = (
    reason: "manual" | "usage_limit",
    kind: "web" | "mobile" | "server",
    clientId: string | null,
    window: string | null = null,
  ) => ({
    at: "x",
    fromId: "a",
    toId: "b",
    fromName: "A",
    toName: "B",
    reason,
    window,
    initiator: { clientId, kind },
  });
  it.each([
    [entry("manual", "web", "me"), "you switched"],
    [entry("manual", "web", "them"), "you switched · from another window"],
    [entry("manual", "mobile", "phone"), "you switched · from your phone"],
    [entry("usage_limit", "server", null, "5-hour"), "out of usage: 5-hour · automatically"],
  ] as const)("%j", (value, expected) => {
    expect(switchReasonText(value, "me")).toBe(expected);
  });
});

describe("mcpServerRowModel", () => {
  const server = (overrides: Partial<ProviderMcpServer>): ProviderMcpServer => ({
    key: "user:-:jira",
    name: "jira",
    scope: "user",
    scopeDetail: null,
    transport: "http",
    target: "https://jira/mcp",
    headerNames: [],
    envNames: [],
    state: "connected",
    checking: false,
    error: null,
    tools: [{ name: "t", readOnly: true, destructive: false }],
    signedIn: true,
    canEdit: true,
    canRemove: true,
    canToggle: true,
    canSignIn: true,
    ...overrides,
  });
  it.each([
    [
      "connected, project picked",
      server({}),
      true,
      {
        status: "Connected · 1 tool",
        action: null,
        menu: ["check", "reconnect", "sign-out", "turn-off", "edit", "copy", "remove"],
      },
    ],
    [
      "connected, no project",
      server({}),
      false,
      { menu: ["check", "reconnect", "sign-out", "edit", "copy", "remove"] },
    ],
    [
      "needs sign-in",
      server({ state: "needs-auth", signedIn: false }),
      false,
      { status: "Sign-in needed", action: "sign-in" },
    ],
    [
      "failed",
      server({ state: "failed", error: "refused" }),
      false,
      { status: "Couldn't connect: refused", action: "retry" },
    ],
    [
      "off",
      server({ state: "disabled" }),
      true,
      { status: "Off in this project", action: "turn-on" },
    ],
    [
      "not checked",
      server({ state: "unknown", signedIn: false }),
      false,
      { status: "Not checked yet", action: null },
    ],
    [
      "plugin",
      server({ scope: "plugin", scopeDetail: "docs", canEdit: false, canRemove: false }),
      false,
      {
        managedReason: "Comes from the plugin docs. Turn the plugin off in Claude to remove it.",
        menu: ["check", "reconnect", "sign-out", "copy"],
      },
    ],
  ] as const)("%s", (_name, value, projectPicked, expected) => {
    expect(mcpServerRowModel({ server: value, projectPicked, signingIn: false })).toMatchObject(
      expected,
    );
  });
});
