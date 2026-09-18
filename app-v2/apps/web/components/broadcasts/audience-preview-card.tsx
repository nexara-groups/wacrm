import { AlertTriangle, Users } from "lucide-react";
import type { AudiencePreview } from "@packages/contracts/src/broadcasts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * THE centrepiece screen per META_ERROR_TAXONOMY.md §4b: total audience,
 * how many will actually be sent to, and the skipped contacts GROUPED BY
 * REASON with a plain-language label — never a flat list, never just a
 * count. `preview` is `toAudiencePreviewDTO`'s output as-is; this component
 * only renders it.
 */
export function AudiencePreviewCard({ preview }: { preview: AudiencePreview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" />
          Audience preview
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm font-medium">{preview.summary}</p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Total matched" value={preview.totalMatchedCount} />
          <Stat label="Will send" value={preview.willSendCount} emphasis="positive" />
          <Stat label="Will skip" value={preview.skippedCount} emphasis={preview.skippedCount > 0 ? "warning" : undefined} />
        </div>

        {preview.skippedGroups.length > 0 && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <AlertTriangle className="size-3.5" />
              Skipped, grouped by reason — these numbers will not be sent to
            </p>
            <ul className="space-y-1.5">
              {preview.skippedGroups.map((group) => (
                <li key={group.reason} className="flex items-center justify-between gap-3 text-sm">
                  <span className="capitalize text-foreground">{group.label}</span>
                  <Badge variant="outline">{group.count.toLocaleString("en-US")}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: "positive" | "warning";
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          emphasis === "positive"
            ? "text-lg font-semibold text-emerald-600 dark:text-emerald-400"
            : emphasis === "warning"
              ? "text-lg font-semibold text-amber-700 dark:text-amber-400"
              : "text-lg font-semibold"
        }
      >
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}
