import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeAccountStoreDir, migrateClaudeAccountFolders } from "./ClaudeAccountsMigration.ts";

const login = (account: string, org: string, refreshToken: string) => ({
  claudeAiOauth: { accountUuid: account, organizationUuid: org, refreshToken, accessToken: "a" },
  organizationUuid: org,
});

it.layer(NodeServices.layer)("migrateClaudeAccountFolders", (it) => {
  describe("folds account folders into the one Claude folder", () => {
    it.effect(
      "moves logins, keeps names, aliases ids, leaves separate folders, and re-runs safely",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-migration-",
          });
          const stateDir = path.join(home, "state");
          const main = path.join(home, ".claude");
          const write = (file: string, value: unknown) =>
            fileSystem
              .makeDirectory(path.dirname(file), { recursive: true })
              .pipe(Effect.andThen(fileSystem.writeFileString(file, JSON.stringify(value))));
          const read = (file: string) =>
            fileSystem.readFileString(file).pipe(
              Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
              Effect.orElseSucceed(() => undefined),
            );
          yield* fileSystem.makeDirectory(path.join(main, "projects"), { recursive: true });
          yield* write(path.join(main, ".credentials.json"), {
            ...login("a", "oa", "rt-a"),
            mcpOAuth: { j: 1 },
          });
          const accountFolder = (name: string) => path.join(home, ".claude-accounts", name);
          for (const name of ["team", "office"]) {
            yield* fileSystem.makeDirectory(accountFolder(name), { recursive: true });
            yield* fileSystem.symlink(
              path.join(main, "projects"),
              path.join(accountFolder(name), "projects"),
            );
          }
          yield* write(path.join(accountFolder("team"), ".credentials.json"), {
            ...login("b", "ob", "rt-b"),
            mcpOAuth: { k: 2 },
          });
          yield* write(path.join(accountFolder("team"), ".claude.json"), {
            oauthAccount: { emailAddress: "team@example.com", organizationName: "Team Org" },
          });
          yield* fileSystem.makeDirectory(path.join(home, "separate", "projects"), {
            recursive: true,
          });

          const settings: ServerSettings = {
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: "claudeAgent",
                displayName: "main@example.com",
                config: {},
              },
              [ProviderInstanceId.make("claude_team")]: {
                driver: "claudeAgent",
                displayName: "team@example.com (Team)",
                config: { homePath: accountFolder("team") },
              },
              [ProviderInstanceId.make("claude_office")]: {
                driver: "claudeAgent",
                displayName: "office@example.com (Max 20x)",
                enabled: false,
                config: { homePath: accountFolder("office"), accountEmail: "office@example.com" },
              },
              [ProviderInstanceId.make("claude_separate")]: {
                driver: "claudeAgent",
                config: { homePath: path.join(home, "separate") },
              },
            },
            textGenerators: { [ProviderInstanceId.make("claude_team")]: { model: "x" } } as never,
          } as unknown as ServerSettings;
          const options = { stateDir, homeDir: home, claudeConfigDir: undefined };

          const next = yield* migrateClaudeAccountFolders(settings, options);
          expect(Object.keys(next.providerInstances).toSorted()).toEqual([
            "claudeAgent",
            "claude_separate",
          ]);
          expect(next.providerInstanceAliases).toEqual({
            claude_team: "claudeAgent",
            claude_office: "claudeAgent",
          });
          expect(Object.keys(next.textGenerators)).toEqual(["claudeAgent"]);

          const store = claudeAccountStoreDir(stateDir, yield* fileSystem.realPath(main));
          expect(
            (yield* read(path.join(store, "b.ob", ".credentials.json")))?.claudeAiOauth,
          ).toEqual(login("b", "ob", "rt-b").claudeAiOauth);
          // The old folder keeps everything but the login.
          expect(yield* read(path.join(accountFolder("team"), ".credentials.json"))).toEqual({
            mcpOAuth: { k: 2 },
          });
          const index = (yield* read(path.join(store, "index.json"))) as {
            accounts: Array<Record<string, unknown>>;
          };
          expect(
            index.accounts.map((entry) => [entry.id, entry.name, entry.email, entry.autoSwitch]),
          ).toEqual([
            ["a.oa", "main@example.com", null, true],
            ["b.ob", "team@example.com (Team)", "team@example.com", true],
            ["pending:claude_office", "office@example.com (Max 20x)", "office@example.com", false],
          ]);

          // A crash before settings were written: the same input runs again without duplicates.
          const again = yield* migrateClaudeAccountFolders(settings, options);
          expect(again.providerInstanceAliases).toEqual(next.providerInstanceAliases);
          const reread = (yield* read(path.join(store, "index.json"))) as { accounts: unknown[] };
          expect(reread.accounts).toHaveLength(3);
          // Nothing left to fold: the migrated settings come back unchanged.
          expect(yield* migrateClaudeAccountFolders(next, options)).toBe(next);
        }),
    );
  });
});
