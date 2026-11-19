import { describe, expect, it } from "vite-plus/test";

import { claudeAccountFolder } from "./claudeAccounts.ts";

describe("claudeAccountFolder", () => {
  it("names the folder after the account and skips folders other instances use", () => {
    expect(claudeAccountFolder(" Office@Pixel-Robotics.eu ", {})).toBe(
      "~/.claude-accounts/office-pixel-robotics-eu",
    );
    expect(
      claudeAccountFolder("work", {
        claudeAgent_work: { config: { shadowHomePath: "~/.claude-accounts/work" } },
        claudeAgent_old: { config: { homePath: "~/.claude-accounts/work-2" } },
      }),
    ).toBe("~/.claude-accounts/work-3");
    expect(claudeAccountFolder("", {})).toBe("~/.claude-accounts/account");
  });
});
