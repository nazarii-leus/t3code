import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";

const Usage = Schema.Struct({
  window: Schema.String,
  leftPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
});

const ClaudeAccountsReadTool = Tool.make("t3_claude_accounts", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [ProviderRegistry.ProviderRegistry],
  description:
    "Read this environment's Claude accounts: which is active, each plan, sign-in end, and the 5-hour, weekly and per-model usage left, plus recent switches. Switching stays a person's action in Settings.",
  success: Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        instanceId: Schema.String,
        switching: Schema.Boolean,
        nextAccount: Schema.NullOr(Schema.String),
        accounts: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            plan: Schema.NullOr(Schema.String),
            organization: Schema.NullOr(Schema.String),
            active: Schema.Boolean,
            state: Schema.String,
            signInEndsAt: Schema.NullOr(Schema.String),
            usage: Schema.Array(Usage),
          }),
        ),
        recentSwitches: Schema.Array(
          Schema.Struct({
            at: Schema.String,
            from: Schema.NullOr(Schema.String),
            to: Schema.String,
            reason: Schema.String,
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ClaudeAccountsToolkit = Toolkit.make(ClaudeAccountsReadTool);
