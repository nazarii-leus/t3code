// @effect-diagnostics nodeBuiltinImport:off - the store folder is named by a hash of the Claude folder.
import * as NodeCrypto from "node:crypto";

import type { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { claudeLocks, describeLogin, pickLoginSet, withoutLoginSet } from "./ClaudeAccountStore.ts";

const DEFAULT_CLAUDE_INSTANCE = "claudeAgent" as ProviderInstanceId;
const RECORD_FILE = "migration-claude-accounts.json";
const EMAIL = /[^\s()<>@]+@[^\s()<>@]+\.[^\s()<>@]+/;

const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(JsonValue);
const encodeJson = Schema.encodeEffect(JsonValue);
type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");

/** The store folder of a Claude folder, as the Claude driver names it. */
export const claudeAccountStoreDir = (stateDir: string, realFolder: string) =>
  `${stateDir}/provider-accounts/claude/${NodeCrypto.createHash("sha256").update(realFolder).digest("hex").slice(0, 12)}`;

/**
 * Folds Claude instances that were accounts of the default folder (their own folder links its
 * `projects` into the default's, or they used a shadow home) into the default instance: their
 * logins move into the account store, their ids become aliases, the instances go. Idempotent: a
 * record in the store lists the instances already moved.
 */
export const migrateClaudeAccountFolders = Effect.fn("migrateClaudeAccountFolders")(function* (
  settings: ServerSettings,
  options: {
    readonly stateDir: string;
    readonly homeDir: string;
    readonly claudeConfigDir: string | undefined;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instances = settings.providerInstances;
  const folderOf = (config: Json) => {
    const home = text(config.shadowHomePath) || text(config.homePath);
    return home ? path.resolve(expandHomePath(home, options.homeDir)) : undefined;
  };
  const realPath = (file: string) =>
    fileSystem.realPath(file).pipe(Effect.orElseSucceed(() => file));
  const readJson = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.flatMap(decodeJson),
      Effect.map(asRecord),
      Effect.orElseSucceed((): Json => ({})),
    );
  const writeJson = (file: string, value: unknown) =>
    fileSystem.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(encodeJson(value)),
      Effect.flatMap((raw) => fileSystem.writeFileString(file, raw, { mode: 0o600 })),
    );

  const defaultConfig = asRecord(instances[DEFAULT_CLAUDE_INSTANCE]?.config);
  const defaultFolder =
    folderOf(defaultConfig) ??
    (options.claudeConfigDir
      ? path.resolve(options.claudeConfigDir)
      : path.join(options.homeDir, ".claude"));
  const defaultProjects = yield* realPath(path.join(defaultFolder, "projects"));
  const retired: Array<{
    readonly id: string;
    readonly folder: string;
    readonly config: Json;
    readonly displayName: string;
    readonly enabled: boolean;
  }> = [];
  for (const [id, entry] of Object.entries(instances)) {
    if (id === DEFAULT_CLAUDE_INSTANCE || entry.driver !== "claudeAgent") continue;
    const config = asRecord(entry.config);
    const folder = folderOf(config);
    if (!folder) continue;
    const linked = (yield* realPath(path.join(folder, "projects"))) === defaultProjects;
    if (!text(config.shadowHomePath) && !linked) continue;
    retired.push({
      id,
      folder,
      config,
      displayName: text(entry.displayName),
      enabled: entry.enabled !== false,
    });
  }
  if (retired.length === 0) return settings;

  const storeDir = claudeAccountStoreDir(options.stateDir, yield* realPath(defaultFolder));
  const recordFile = path.join(storeDir, RECORD_FILE);
  const indexFile = path.join(storeDir, "index.json");
  const record = asRecord((yield* readJson(recordFile)).instances);
  const index = yield* readJson(indexFile);
  const accounts = Array.isArray(index.accounts) ? [...(index.accounts as Json[])] : [];
  const now = DateTime.formatIso(yield* DateTime.now);
  const defaultLogin = describeLogin(
    yield* readJson(path.join(defaultFolder, ".credentials.json")),
  );
  const addEntry = (entry: Json) => {
    if (!accounts.some((existing) => existing.id === entry.id)) accounts.push(entry);
  };
  // The default folder's account keeps the name its instance had.
  if (defaultLogin && text(instances[DEFAULT_CLAUDE_INSTANCE]?.displayName)) {
    addEntry({
      id: defaultLogin.accountId,
      name: text(instances[DEFAULT_CLAUDE_INSTANCE]?.displayName).slice(0, 40),
      email: null,
      organizationUuid: defaultLogin.organizationUuid,
      organizationName: null,
      organizationKind: null,
      plan: null,
      autoSwitch: true,
      addedAt: now,
    });
  }
  for (const instance of retired) {
    if (record[instance.id]) continue;
    const accountId = yield* claudeLocks
      .withLocks(
        instance.folder,
        Effect.gen(function* () {
          const credentials = yield* readJson(path.join(instance.folder, ".credentials.json"));
          const login = describeLogin(credentials);
          if (!login) return null;
          const profile = asRecord(
            (yield* readJson(path.join(instance.folder, ".claude.json"))).oauthAccount,
          );
          if (login.accountId !== defaultLogin?.accountId) {
            const target = path.join(storeDir, login.accountId);
            yield* writeJson(path.join(target, ".credentials.json"), pickLoginSet(credentials));
            yield* writeJson(path.join(target, ".claude.json"), {
              hasCompletedOnboarding: true,
              oauthAccount: profile,
            });
          }
          // The store has it (or the default folder does): the old folder keeps everything else.
          yield* writeJson(
            path.join(instance.folder, ".credentials.json"),
            withoutLoginSet(credentials),
          );
          return { login, profile };
        }),
      )
      .pipe(Effect.orElseSucceed(() => null));
    const id = accountId?.login.accountId ?? `pending:${instance.id}`;
    const email =
      text(accountId?.profile.emailAddress) ||
      text(instance.config.accountEmail) ||
      (EMAIL.exec(instance.displayName)?.[0] ?? "");
    addEntry({
      id,
      name: (instance.displayName || email || "Claude account").slice(0, 40),
      email: email || null,
      organizationUuid: accountId?.login.organizationUuid ?? null,
      organizationName: text(accountId?.profile.organizationName) || null,
      organizationKind: null,
      plan: null,
      autoSwitch: instance.enabled,
      addedAt: now,
    });
    record[instance.id] = { folder: instance.folder, accountId: id, at: now };
    yield* writeJson(indexFile, {
      version: 1,
      history: [],
      autoSwitchLog: [],
      pausedUntil: null,
      limitedUntil: {},
      ...index,
      accounts,
    });
    yield* writeJson(recordFile, { instances: record });
  }

  const retiredIds = new Set(retired.map((instance) => instance.id));
  const target = DEFAULT_CLAUDE_INSTANCE;
  const renameKeys = <V>(map: Readonly<Record<string, V>> | null | undefined) => {
    if (!map) return map;
    const kept: Record<string, V> = {};
    for (const [key, value] of Object.entries(map)) if (!retiredIds.has(key)) kept[key] = value;
    for (const [key, value] of Object.entries(map)) {
      if (retiredIds.has(key) && kept[target] === undefined) kept[target] = value;
    }
    return kept;
  };
  const withoutConfigFields = (config: unknown) => {
    const { shadowHomePath: _shadow, accountEmail: _email, ...rest } = asRecord(config);
    return rest;
  };
  return {
    ...settings,
    providerInstances: Object.fromEntries(
      Object.entries(instances)
        .filter(([id]) => !retiredIds.has(id))
        .map(([id, entry]) => [
          id,
          entry.driver === "claudeAgent"
            ? { ...entry, config: withoutConfigFields(entry.config) }
            : entry,
        ]),
    ),
    providerInstanceAliases: {
      ...settings.providerInstanceAliases,
      ...Object.fromEntries(retired.map((instance) => [instance.id, target])),
    },
    textGenerators: renameKeys(settings.textGenerators) ?? settings.textGenerators,
    providerModelPreferences:
      renameKeys(settings.providerModelPreferences) ?? settings.providerModelPreferences,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([projectId, overrides]) => [
        projectId,
        overrides.providerInstances
          ? {
              ...overrides,
              providerInstances: Object.fromEntries(
                Object.entries(overrides.providerInstances).filter(([id]) => !retiredIds.has(id)),
              ),
            }
          : overrides,
      ]),
    ),
  } as ServerSettings;
});
