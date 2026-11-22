import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { AsyncResult } from "effect/reactivity";

import { toastManager } from "../../ui/toast";

/** True when the command succeeded; a failure becomes an error toast, an interrupt stays quiet. */
export function commandSucceeded<A, E>(
  result: AtomCommandResult<A, E>,
  failureTitle: string,
  resolve: Parameters<typeof thrownErrorMessage>[1],
): result is AsyncResult.Success<A, E> {
  if (result._tag === "Success") return true;
  if (isAtomCommandInterrupted(result)) return false;
  const failure = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title: failureTitle,
    description: thrownErrorMessage(failure, resolve) ?? undefined,
  });
  return false;
}
