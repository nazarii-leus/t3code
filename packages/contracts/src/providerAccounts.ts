import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

/**
 * Accounts of a provider that keeps one active login in one folder and the others in a private
 * store. Claude: "<accountUuid>.<organizationUuid>", or "pending:<n>" before a first sign-in.
 */
export const ProviderAccountId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type ProviderAccountId = typeof ProviderAccountId.Type;

export const ProviderAccountName = TrimmedNonEmptyString.check(Schema.isMaxLength(40));

export const ProviderAccount = Schema.Struct({
  id: ProviderAccountId,
  name: ProviderAccountName,
  email: Schema.NullOr(TrimmedNonEmptyString),
  organizationUuid: Schema.NullOr(TrimmedNonEmptyString),
  organizationName: Schema.NullOr(TrimmedNonEmptyString),
  organizationKind: Schema.NullOr(Schema.Literals(["personal", "team", "enterprise"])),
  plan: Schema.NullOr(TrimmedNonEmptyString),
  active: Schema.Boolean,
  state: Schema.Literals(["ready", "signed-out", "expired", "error"]),
  stateMessage: Schema.NullOr(Schema.String),
  /** When the sign-in ends for good; renewing the access token does not move it. */
  signInEndsAt: Schema.NullOr(IsoDateTime),
  autoSwitch: Schema.Boolean,
  /** Model ids this account can use, from its last check. */
  models: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
  usageLimits: Schema.NullOr(ServerProviderUsageLimits),
  usageCheckedAt: Schema.NullOr(IsoDateTime),
  usageError: Schema.NullOr(Schema.String),
});
export type ProviderAccount = typeof ProviderAccount.Type;

export const ProviderAccountSwitchEntry = Schema.Struct({
  at: IsoDateTime,
  fromId: Schema.NullOr(ProviderAccountId),
  toId: ProviderAccountId,
  fromName: Schema.NullOr(Schema.String),
  toName: Schema.String,
  reason: Schema.Literals(["manual", "usage_limit", "sign_in", "outside"]),
  window: Schema.NullOr(Schema.String),
  initiator: Schema.Struct({
    clientId: Schema.NullOr(TrimmedNonEmptyString),
    kind: Schema.Literals(["desktop", "web", "mobile", "agent", "server"]),
  }),
});
export type ProviderAccountSwitchEntry = typeof ProviderAccountSwitchEntry.Type;

export const ProviderAccountsSnapshot = Schema.Struct({
  supported: Schema.Boolean,
  unsupportedReason: Schema.NullOr(Schema.String),
  /** Index order, which is also the order every surface shows. */
  accounts: ForwardCompatibleArray(ProviderAccount),
  switching: Schema.NullOr(
    Schema.Struct({
      fromId: Schema.NullOr(ProviderAccountId),
      toId: ProviderAccountId,
      startedAt: IsoDateTime,
      initiatorClientId: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  lastError: Schema.NullOr(
    Schema.Struct({ at: IsoDateTime, message: Schema.String, toId: ProviderAccountId }),
  ),
  /** Computed on the server; every banner and button reads it instead of guessing. */
  autoSwitch: Schema.Struct({
    targetId: Schema.NullOr(ProviderAccountId),
    blockedReason: Schema.NullOr(Schema.Literals(["off", "paused", "no_candidate", "one_account"])),
    pausedUntil: Schema.NullOr(IsoDateTime),
  }),
  /** Newest first, at most 20. */
  history: ForwardCompatibleArray(ProviderAccountSwitchEntry),
});
export type ProviderAccountsSnapshot = typeof ProviderAccountsSnapshot.Type;

export const ProviderAccountClientKind = Schema.Literals(["desktop", "web", "mobile"]);

export const ProviderAccountsUseInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  accountId: ProviderAccountId,
  clientId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  clientKind: Schema.optionalKey(ProviderAccountClientKind),
});
export type ProviderAccountsUseInput = typeof ProviderAccountsUseInput.Type;

export const ProviderAccountsAccountInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  accountId: ProviderAccountId,
});
export type ProviderAccountsAccountInput = typeof ProviderAccountsAccountInput.Type;

export const ProviderAccountsRenameInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  accountId: ProviderAccountId,
  name: ProviderAccountName,
});
export type ProviderAccountsRenameInput = typeof ProviderAccountsRenameInput.Type;

export const ProviderAccountsSetAutoSwitchInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  accountId: ProviderAccountId,
  enabled: Schema.Boolean,
});
export type ProviderAccountsSetAutoSwitchInput = typeof ProviderAccountsSetAutoSwitchInput.Type;

export const ProviderAccountsCheckUsageInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  accountId: Schema.NullOr(ProviderAccountId),
});
export type ProviderAccountsCheckUsageInput = typeof ProviderAccountsCheckUsageInput.Type;

export const ProviderAccountsInstanceInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ProviderAccountsInstanceInput = typeof ProviderAccountsInstanceInput.Type;

export class ProviderAccountsError extends Schema.TaggedError<ProviderAccountsError>()(
  "ProviderAccountsError",
  {
    instanceId: ProviderInstanceId,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Auth method ids that belong to the account list, not to the generic Account row. */
export const PROVIDER_ACCOUNT_ADD_METHOD_ID = "account:add";
export const PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX = "account:renew:";
export const isProviderAccountMethodId = (methodId: string): boolean =>
  methodId.startsWith("account:");
