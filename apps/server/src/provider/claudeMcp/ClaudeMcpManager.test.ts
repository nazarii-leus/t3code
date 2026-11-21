import { describe, expect, it } from "@effect/vitest";

import { redactMcpTarget } from "./ClaudeMcpManager.ts";

describe("redactMcpTarget", () => {
  it("keeps only the origin and path of a URL", () => {
    expect(
      redactMcpTarget({ type: "http", url: "https://user:pass@mcp.example.com/mcp?key=secret" }),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("masks token-like arguments of a command", () => {
    expect(
      redactMcpTarget({
        command: "npx",
        args: [
          "notes-mcp",
          "--token",
          "abc",
          "--api-key=xyz",
          "API_KEY=1",
          "notarealsecret0123456789abcdef",
        ],
      }),
    ).toBe("npx notes-mcp --token •••• --api-key=•••• API_KEY=•••• ••••");
  });
});
