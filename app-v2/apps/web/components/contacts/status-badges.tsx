import type { ConsentState, DeliverabilityState } from "@packages/contracts/src/common/vocab";
import { Badge, type BadgeProps } from "@/components/ui/badge";

const CONSENT_LABEL: Record<ConsentState, string> = {
  unknown: "Unknown",
  opted_in: "Opted in",
  opted_out: "Opted out",
  do_not_contact: "Do not contact",
};

const CONSENT_VARIANT: Record<ConsentState, BadgeProps["variant"]> = {
  unknown: "outline",
  opted_in: "success",
  opted_out: "destructive",
  do_not_contact: "destructive",
};

const DELIVERABILITY_LABEL: Record<DeliverabilityState, string> = {
  unknown: "Unknown",
  reachable: "Reachable",
  suppressed: "Suppressed",
  manually_cleared: "Manually cleared",
};

const DELIVERABILITY_VARIANT: Record<DeliverabilityState, BadgeProps["variant"]> = {
  unknown: "outline",
  reachable: "success",
  suppressed: "destructive",
  manually_cleared: "warning",
};

export function ConsentBadge({ state }: { state: ConsentState }) {
  return <Badge variant={CONSENT_VARIANT[state]}>{CONSENT_LABEL[state]}</Badge>;
}

export function DeliverabilityBadge({
  state,
  reasonCode,
}: {
  state: DeliverabilityState;
  reasonCode: string | null;
}) {
  const label = DELIVERABILITY_LABEL[state];
  return (
    <Badge variant={DELIVERABILITY_VARIANT[state]} title={reasonCode ? `Meta error ${reasonCode}` : undefined}>
      {state === "suppressed" && reasonCode ? `${label} · ${reasonCode}` : label}
    </Badge>
  );
}
