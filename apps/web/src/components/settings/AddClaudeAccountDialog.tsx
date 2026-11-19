import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { claudeAccountFolder } from "@t3tools/client-runtime/claude-accounts";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@t3tools/client-runtime/provider-instance-ids";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { m as resolveMessage } from "~/i18n/messages";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

export function AddClaudeAccountDialog({
  environmentId,
  environmentLabel,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onCreated?: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [email, setEmail] = useState("");
  // The name follows the email until it is edited.
  const [name, setName] = useState<string | null>(null);
  const [shareSettings, setShareSettings] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const providerInstances = settings.providerInstances ?? {};
  const label = (name ?? email).trim();
  const accountFolder = (folder ?? claudeAccountFolder(label, providerInstances)).trim();

  const createAccount = async () => {
    if (pending || !label || !accountFolder) return;
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setPending(true);
    const id = ProviderInstanceId.make(
      deriveAvailableInstanceId(
        (candidate) => deriveInstanceId(CLAUDE_DRIVER_KIND, candidate) || CLAUDE_DRIVER_KIND,
        label,
        new Set([CLAUDE_DRIVER_KIND, ...Object.keys(providerInstances)]),
      ),
    );
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: id,
      instance: {
        driver: CLAUDE_DRIVER_KIND,
        enabled: true,
        displayName: label,
        config: {
          [shareSettings ? "shadowHomePath" : "homePath"]: accountFolder,
          ...(email.trim() ? { accountEmail: email.trim() } : {}),
        },
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not add provider instance"),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("The settings update failed."),
      });
      return;
    }
    onCreated?.(id);
    setInstanceId(id);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={gt("Add Claude account")}
          description={gt(
            "Each account signs in on its own. Choose the same account on Claude's sign-in page.",
          )}
        >
          <WizardSteps
            steps={[
              gt("Account", { $context: "wizard step" }),
              gt("Sign in", { $context: "wizard step" }),
            ]}
            currentStep={instanceId ? 1 : 0}
          />
        </WizardHeader>
        {instanceId ? (
          <ProviderWizardAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            onFinish={onClose}
          />
        ) : (
          <>
            <WizardPanel>
              <form
                id="add-claude-account"
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createAccount();
                }}
              >
                <SettingsGroup variant="plain">
                  <SettingsRow
                    title={gt("Email")}
                    description={gt("Fills in Claude's sign-in page. Optional.")}
                    control={
                      <Input
                        aria-label={gt("Email")}
                        type="email"
                        autoComplete="off"
                        value={email}
                        disabled={pending}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                      />
                    }
                  />
                  <SettingsRow
                    title={gt("Account name")}
                    description={gt("Shown in the provider list and model picker.")}
                    control={
                      <Input
                        aria-label={gt("Account name")}
                        value={name ?? email}
                        disabled={pending}
                        onChange={(event) => setName(event.target.value)}
                        placeholder={gt("e.g. Personal or Work")}
                      />
                    }
                  />
                  <SettingsRow
                    title={gt("Share settings with the main account")}
                    description={gt(
                      "Uses the same rules, settings, skills, plugins, MCP servers and chats. Only the login is separate, so threads continue when T3 Code switches accounts.",
                    )}
                    control={
                      <Switch
                        aria-label={gt("Share settings with the main account")}
                        checked={shareSettings}
                        disabled={pending}
                        onCheckedChange={(checked) => setShareSettings(Boolean(checked))}
                      />
                    }
                  />
                </SettingsGroup>
                <Collapsible>
                  <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
                    <T>Advanced</T>
                    <ChevronDownIcon aria-hidden />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <SettingsGroup variant="plain">
                      <SettingsRow
                        title={gt("Account folder")}
                        description={gt("Claude keeps this account's login here.")}
                        control={
                          <Input
                            aria-label={gt("Account folder")}
                            value={accountFolder}
                            disabled={pending}
                            onChange={(event) => setFolder(event.target.value)}
                          />
                        }
                      />
                    </SettingsGroup>
                  </CollapsiblePanel>
                </Collapsible>
              </form>
            </WizardPanel>
            <WizardFooter>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                <T>Cancel</T>
              </Button>
              <Button
                type="submit"
                form="add-claude-account"
                disabled={pending || !label || !accountFolder || !canManageProviders}
              >
                {pending ? gt("Adding account…") : gt("Continue to sign-in")}
              </Button>
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}
