import { describe, expect, it } from "@effect/vitest";
import type { ProviderAccount } from "@t3tools/contracts";

import { pickAccountSwitchTarget } from "./ClaudeAccounts.ts";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const account = (
  id: string,
  windows: ReadonlyArray<{
    id: string;
    kind: "session" | "weekly";
    used: number;
    resetsAt?: string;
    modelIds?: string[];
  }>,
  overrides: Partial<ProviderAccount> = {},
): ProviderAccount => ({
  id,
  name: id,
  email: null,
  organizationUuid: null,
  organizationName: null,
  organizationKind: "personal",
  plan: "Max 20x",
  active: false,
  state: "ready",
  stateMessage: null,
  signInEndsAt: null,
  autoSwitch: true,
  models: ["claude-fable-5-2", "claude-sonnet-5-5"],
  usageLimits: {
    checkedAt: "2026-11-21T11:59:00.000Z",
    windows: windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      label: window.id,
      usedPercent: window.used,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      ...(window.modelIds ? { modelIds: window.modelIds } : {}),
    })),
  },
  usageCheckedAt: "2026-11-21T11:59:00.000Z",
  usageError: null,
  ...overrides,
});
const pick = (
  accounts: ReadonlyArray<ProviderAccount>,
  extra: Partial<Parameters<typeof pickAccountSwitchTarget>[0]> = {},
) =>
  pickAccountSwitchTarget({
    accounts,
    limitedUntil: {},
    now: NOW,
    modelsInUse: [],
    windowId: "five_hour",
    ...extra,
  })?.id;

describe("pickAccountSwitchTarget", () => {
  it("prefers the account whose weekly budget resets first, among those with room", () => {
    const early = account("early", [
      { id: "five_hour", kind: "session", used: 40 },
      { id: "seven_day", kind: "weekly", used: 70, resetsAt: "2026-11-22T00:00:00.000Z" },
    ]);
    const late = account("late", [
      { id: "five_hour", kind: "session", used: 0 },
      { id: "seven_day", kind: "weekly", used: 10, resetsAt: "2026-11-27T00:00:00.000Z" },
    ]);
    expect(pick([late, early])).toBe("early");
  });

  it("skips the active, exhausted, signed-out, excluded and unread accounts", () => {
    const ok = account("ok", [{ id: "five_hour", kind: "session", used: 10 }]);
    expect(
      pick([
        account("active", [{ id: "five_hour", kind: "session", used: 0 }], { active: true }),
        account("full", [
          { id: "five_hour", kind: "session", used: 100, resetsAt: "2026-11-21T14:00:00.000Z" },
        ]),
        account("out", [{ id: "five_hour", kind: "session", used: 0 }], { state: "signed-out" }),
        account("skip", [{ id: "five_hour", kind: "session", used: 0 }], { autoSwitch: false }),
        account("unread", [], { usageLimits: null }),
        ok,
      ]),
    ).toBe("ok");
  });

  it("skips an account known to be limited until its reset, and one missing a model in use", () => {
    const limited = account("limited", [{ id: "five_hour", kind: "session", used: 10 }]);
    const noFable = account("no-fable", [{ id: "five_hour", kind: "session", used: 10 }], {
      models: ["claude-sonnet-5-5"],
    });
    expect(
      pick([limited, noFable], {
        limitedUntil: { limited: { five_hour: "2026-11-21T13:00:00.000Z" } },
        modelsInUse: ["claude-fable-5-2"],
      }),
    ).toBeUndefined();
    expect(
      pick([limited], { limitedUntil: { limited: { five_hour: "2026-11-21T11:00:00.000Z" } } }),
    ).toBe("limited");
  });

  it("treats an exhausted per-model window as no room", () => {
    const fableOut = account("fable-out", [
      { id: "five_hour", kind: "session", used: 0 },
      {
        id: "fable",
        kind: "weekly",
        used: 100,
        resetsAt: "2026-11-25T00:00:00.000Z",
        modelIds: ["claude-fable-5-2"],
      },
    ]);
    expect(pick([fableOut])).toBeUndefined();
  });
});
