import { Check, CheckCheck, Clock, TriangleAlert, Eye } from "lucide-react";
import type { RecipientStatus } from "@packages/contracts/src/common/vocab";
import { Badge, type BadgeProps } from "@/components/ui/badge";

const STATUS_LABEL: Record<RecipientStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  replied: "Replied",
  failed: "Failed",
};

const STATUS_VARIANT: Record<RecipientStatus, BadgeProps["variant"]> = {
  pending: "outline",
  sent: "secondary",
  delivered: "secondary",
  read: "success",
  replied: "success",
  failed: "destructive",
};

const STATUS_ICON: Record<RecipientStatus, React.ComponentType<{ className?: string }>> = {
  pending: Clock,
  sent: Check,
  delivered: CheckCheck,
  read: Eye,
  replied: Eye,
  failed: TriangleAlert,
};

/** Per-message outbound delivery status — sent/delivered/read/failed, per the task brief. */
export function MessageStatusBadge({ status }: { status: RecipientStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={STATUS_VARIANT[status]} className="gap-1">
      <Icon className="size-3" />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** The unread-count pill shown on a conversation row. */
export function UnreadCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <Badge variant="default">{count > 99 ? "99+" : count}</Badge>;
}
