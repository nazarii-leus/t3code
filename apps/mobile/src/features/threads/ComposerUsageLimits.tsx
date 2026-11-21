import { providerClients } from "@t3tools/client-runtime/provider-clients";
import type { EnvironmentId, UsageLimitsReport } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react-native";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { ControlPill } from "../../components/ui/ControlPill";
import { environmentPresentations } from "../../state/presentation";
import { useClaudeAccountSwitch } from "../settings/useClaudeAccountSwitch";
import { AppText as Text } from "../../components/ui/AppText";
import { AccountLimits, ResetCredits } from "../usage/UsageLimitsSection";

export function ComposerUsageLimits({
  report,
  environmentId,
  maxHeight,
  onClose,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
  readonly maxHeight: number;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const now = Date.parse(report.createdAt);
  const providers =
    useAtomValue(environmentPresentations.presentationsWithProvidersAtom).get(environmentId)
      ?.serverConfig?.providers ?? [];
  const accountSwitch = useClaudeAccountSwitch();
  const close = (
    <Pressable
      accessibilityLabel={gt("Dismiss usage limits")}
      accessibilityRole="button"
      hitSlop={12}
      onPress={onClose}
      className="-me-1 p-1 active:opacity-60"
    >
      <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
    </Pressable>
  );
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={{ maxHeight }}>
        {report.accounts.map((account, index) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const driverLabel = providerClients.get(account.driver)?.label ?? account.driver;
          // An account of an instance that switches accounts in place (Claude) can be made active.
          const provider = account.providerAccount
            ? providers.find((candidate) => candidate.instanceId === account.instanceId)
            : undefined;
          const switchTarget =
            account.providerAccount &&
            !account.providerAccount.active &&
            account.providerAccount.ready
              ? provider?.accounts?.accounts.find(
                  (candidate) => candidate.id === account.providerAccount?.id,
                )
              : undefined;
          const useButton =
            provider && switchTarget ? (
              <ControlPill
                variant="pill"
                label={gt("Use")}
                accessibilityLabel={gt("Use {name}", { name: switchTarget.name })}
                disabled={provider.accounts?.switching != null}
                onPress={() =>
                  accountSwitch.requestSwitch({ environmentId, provider, account: switchTarget })
                }
              />
            ) : undefined;
          return (
            <AccountLimits
              key={account.id}
              dense
              first={index === 0}
              driver={account.driver}
              accentColor={account.accentColor}
              label={driverLabel}
              instanceLabel={
                account.providerAccount
                  ? account.label
                  : account.instanceId
                    ? account.displayName?.trim() ||
                      (String(account.instanceId) !== String(account.driver)
                        ? account.instanceId
                        : driverLabel)
                    : account.label
              }
              detail={
                account.providerAccount?.active
                  ? [account.plan, gt("Active")].filter(Boolean).join(" · ")
                  : account.plan
              }
              limits={account.limits}
              now={now}
              trailing={
                index === 0 && useButton ? (
                  <View className="flex-row items-center gap-2">
                    {useButton}
                    {close}
                  </View>
                ) : index === 0 ? (
                  close
                ) : (
                  useButton
                )
              }
              footer={
                resetCreditInput && account.limits.resetCredits ? (
                  <ResetCredits
                    dense
                    environmentId={environmentId}
                    input={resetCreditInput}
                    credits={account.limits.resetCredits}
                    now={now}
                  />
                ) : undefined
              }
            />
          );
        })}
        {report.accounts.length === 0 ? (
          <View className="flex-row items-center gap-3 px-4 pt-3">
            <Text className="min-w-0 flex-1 text-base text-foreground">
              <T>Usage limits</T>
            </Text>
            {close}
          </View>
        ) : null}
        {report.notices.map((notice) => (
          <Text
            key={notice}
            className={
              report.accounts.length === 0
                ? "px-4 py-3 text-xs text-foreground-muted"
                : "border-t border-border-subtle px-4 py-3 text-xs text-foreground-muted"
            }
          >
            {notice}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
