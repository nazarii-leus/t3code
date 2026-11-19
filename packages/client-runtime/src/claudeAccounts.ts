const ACCOUNTS_DIRECTORY = "~/.claude-accounts";

function configuredFolders(
  providerInstances: Readonly<Record<string, { readonly config?: unknown }>>,
): ReadonlySet<string> {
  const folders = new Set<string>();
  for (const instance of Object.values(providerInstances)) {
    if (instance.config === null || typeof instance.config !== "object") continue;
    const config = instance.config as Record<string, unknown>;
    for (const value of [config.homePath, config.shadowHomePath]) {
      if (typeof value === "string") folders.add(value.trim());
    }
  }
  return folders;
}

/** A folder under ~/.claude-accounts named after the account that no instance uses yet. */
export function claudeAccountFolder(
  account: string,
  providerInstances: Readonly<Record<string, { readonly config?: unknown }>>,
): string {
  const used = configuredFolders(providerInstances);
  const name =
    account
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "account";
  for (let suffix = 1; ; suffix += 1) {
    const folder = `${ACCOUNTS_DIRECTORY}/${suffix === 1 ? name : `${name}-${suffix}`}`;
    if (!used.has(folder)) return folder;
  }
}
