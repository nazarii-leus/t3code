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

describe("redactMcpTarget hides secrets in every place a server can carry them", () => {
  it.each([
    [
      "a URL argument with a token in its query",
      { command: "mcp-remote", args: ["https://mcp.example.com/sse?token=abc123"] },
      "mcp-remote https://mcp.example.com/sse",
    ],
    [
      "a header flag and its value",
      { command: "mcp-remote", args: ["--header", "Authorization: Bearer abc123"] },
      "mcp-remote --header ••••",
    ],
    [
      "an authorization value without a flag",
      { command: "mcp-remote", args: ["Authorization: Bearer abc123"] },
      "mcp-remote ••••",
    ],
    [
      "a token in the URL path",
      { type: "http", url: "https://mcp.example.com/s/0123456789abcdefghijklmnop/mcp" },
      "https://mcp.example.com/s/••••/mcp",
    ],
  ])("%s", (_name, config, expected) => {
    expect(redactMcpTarget(config)).toBe(expected);
  });
});
