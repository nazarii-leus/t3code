import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planClaudeAccountSave } from "./claude-accounts";

const claude = ProviderDriverKind.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");

describe("planClaudeAccountSave", () => {
  it("adds an account that shares the main settings in a free folder and id", () => {
    const providerInstances: ServerSettings["providerInstances"] = {
      [work]: { driver: claude, config: { shadowHomePath: "~/.claude-accounts/work" } },
    };
    const plan = (name: string, email: string) =>
      planClaudeAccountSave({
        providerInstances,
        policy: undefined,
        instanceId: null,
        draft: { name, configDir: "", email },
        sharedAccount: true,
      });

    expect(plan(" Work ", " office@example.com ")).toEqual({
      mutation: {
        operation: "create",
        instanceId: "claudeAgent_work_2",
        instance: {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Work",
          config: {
            shadowHomePath: "~/.claude-accounts/work-2",
            accountEmail: "office@example.com",
          },
        },
      },
    });
    expect(plan("", "office@example.com")).toMatchObject({
      mutation: { instance: { displayName: "office@example.com" } },
    });
    expect(plan("", " ")).toHaveProperty("error");
  });

  it("adds a signed-in config folder where the server cannot sign Claude in", () => {
    const plan = (configDir: string) =>
      planClaudeAccountSave({
        providerInstances: {},
        policy: undefined,
        instanceId: null,
        draft: { name: "Work", configDir },
      });
    expect(plan(" ~/.claude-work ")).toMatchObject({
      mutation: { instance: { config: { homePath: "~/.claude-work" } } },
    });
    expect(plan(" ")).toHaveProperty("error");
  });

  it("edits the name and folder without dropping the instance's other settings", () => {
    const providerInstances: ServerSettings["providerInstances"] = {
      [work]: {
        driver: claude,
        displayName: "Work",
        accentColor: "#ff0000",
        enabled: false,
        environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
        config: { homePath: "~/.claude-work", binaryPath: "/opt/claude", launchArgs: "--chrome" },
      },
    };
    const edit = (name: string, configDir: string) =>
      planClaudeAccountSave({
        providerInstances,
        policy: undefined,
        instanceId: work,
        draft: { name, configDir },
      });

    expect(edit("Willy", "~/.claude-willy")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          ...providerInstances[work],
          displayName: "Willy",
          config: {
            binaryPath: "/opt/claude",
            launchArgs: "--chrome",
            homePath: "~/.claude-willy",
          },
        },
      },
    });
    // Clearing both falls back to the driver's label and the default ~/.claude folder.
    expect(edit("", "")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          driver: claude,
          accentColor: "#ff0000",
          enabled: false,
          environment: providerInstances[work]!.environment,
          config: { binaryPath: "/opt/claude", launchArgs: "--chrome" },
        },
      },
    });
    expect(
      planClaudeAccountSave({
        providerInstances: { [work]: { driver: claude, config: { homePath: "~/.claude-work" } } },
        policy: undefined,
        instanceId: work,
        draft: { name: "", configDir: "" },
      }),
    ).toEqual({
      mutation: { operation: "upsert", instanceId: work, instance: { driver: claude } },
    });
  });

  it("edits the folder of an account that shares the main settings", () => {
    expect(
      planClaudeAccountSave({
        providerInstances: {
          [work]: { driver: claude, config: { shadowHomePath: "~/.claude-accounts/work" } },
        },
        policy: undefined,
        instanceId: work,
        draft: { name: "Work", configDir: "~/.claude-accounts/office" },
      }),
    ).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          driver: claude,
          displayName: "Work",
          config: { shadowHomePath: "~/.claude-accounts/office" },
        },
      },
    });
  });

  it("refuses instances the managed policy pins", () => {
    const policy: ManagedPolicySummary = {
      organization: "Example Corp",
      lockedSettings: ["providerInstances.claudeAgent_work.config.homePath"],
    };
    expect(
      planClaudeAccountSave({
        providerInstances: { [work]: { driver: claude } },
        policy,
        instanceId: work,
        draft: { name: "Work", configDir: "~/.claude-other" },
      }),
    ).toEqual({ error: "Managed by Example Corp." });
  });
});
