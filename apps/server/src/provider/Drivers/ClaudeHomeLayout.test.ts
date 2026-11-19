import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { ClaudeShadowHomeError, materializeClaudeShadowHome } from "./ClaudeHomeLayout.ts";

const setup = Effect.fn("ClaudeHomeLayout.test.setup")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-claude-shadow-" });
  const layout = {
    sharedHomePath: path.join(root, ".claude"),
    sharedAccountFile: path.join(root, ".claude.json"),
    shadowHomePath: path.join(root, "accounts", "work"),
  };
  yield* fileSystem.makeDirectory(path.join(layout.sharedHomePath, "skills", "review"), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(path.join(layout.sharedHomePath, "CLAUDE.md"), "rules");
  yield* fileSystem.writeFileString(path.join(layout.sharedHomePath, "settings.json"), "{}");
  yield* fileSystem.writeFileString(path.join(layout.sharedHomePath, ".credentials.json"), "main");
  yield* fileSystem.writeFileString(
    layout.sharedAccountFile,
    JSON.stringify({
      oauthAccount: { emailAddress: "main@example.com" },
      mcpServers: { jira: { type: "http", url: "https://jira.example.com/mcp" } },
    }),
  );
  return { fileSystem, path, layout };
});

it.layer(NodeServices.layer)("materializeClaudeShadowHome", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "shares the configuration and MCP servers, never the login",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, layout } = yield* setup();
        const shadow = (name: string) => path.join(layout.shadowHomePath, name);
        yield* fileSystem.makeDirectory(layout.shadowHomePath, { recursive: true });
        yield* fileSystem.writeFileString(shadow(".credentials.json"), "work");
        yield* fileSystem.writeFileString(
          shadow(".claude.json"),
          JSON.stringify({
            oauthAccount: { emailAddress: "work@example.com" },
            mcpServers: { local: { type: "stdio", command: "local-mcp" } },
          }),
        );

        yield* materializeClaudeShadowHome(layout);

        for (const name of ["CLAUDE.md", "settings.json", "skills", "projects"]) {
          expect(yield* fileSystem.realPath(shadow(name))).toBe(
            yield* fileSystem.realPath(path.join(layout.sharedHomePath, name)),
          );
        }
        expect(yield* fileSystem.readFileString(shadow(".credentials.json"))).toBe("work");
        expect(JSON.parse(yield* fileSystem.readFileString(shadow(".claude.json")))).toEqual({
          oauthAccount: { emailAddress: "work@example.com" },
          mcpServers: {
            local: { type: "stdio", command: "local-mcp" },
            jira: { type: "http", url: "https://jira.example.com/mcp" },
          },
        });

        // A server added to the main account reaches the shadow home on the next check.
        yield* fileSystem.writeFileString(
          layout.sharedAccountFile,
          JSON.stringify({ mcpServers: { zulip: { type: "http", url: "https://z.example.com" } } }),
        );
        yield* materializeClaudeShadowHome(layout);
        expect(
          JSON.parse(yield* fileSystem.readFileString(shadow(".claude.json"))).mcpServers,
        ).toMatchObject({ local: {}, zulip: { type: "http", url: "https://z.example.com" } });
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)("keeps an account's own file where a link belongs", () =>
    Effect.gen(function* () {
      const { fileSystem, path, layout } = yield* setup();
      const ownSettings = path.join(layout.shadowHomePath, "settings.json");
      yield* fileSystem.makeDirectory(layout.shadowHomePath, { recursive: true });
      yield* fileSystem.writeFileString(ownSettings, '{"own":true}');

      const error = yield* Effect.flip(materializeClaudeShadowHome(layout));

      expect(error).toBeInstanceOf(ClaudeShadowHomeError);
      expect(error.message).toContain(ownSettings);
      expect(yield* fileSystem.readFileString(ownSettings)).toBe('{"own":true}');
    }).pipe(Effect.scoped),
  );
});
