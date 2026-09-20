/**
 * `/platform/audit` — see `app/api/platform/audit/route.ts`'s file header
 * for the full explanation: `PlatformAuditLogPort` only supports `append`,
 * not listing, so there is no real data this screen can show yet. It still
 * enforces the same access seam as every other platform page (a
 * non-platform user gets `PlatformDenied`, not a peek at this message),
 * and it says plainly what is missing rather than rendering an empty table
 * that looks like "no entries yet".
 */
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPlatformPrincipal } from "@/lib/platform-principal";
import { PlatformDenied } from "@/components/platform/platform-denied";

export const dynamic = "force-dynamic";

export default async function PlatformAuditPage() {
  const principal = await getPlatformPrincipal();
  if (principal === null) {
    return <PlatformDenied />;
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-1 text-xl font-semibold">Audit log</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Who did what, to which account, when, and why.
      </p>

      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <CardTitle>Not readable yet — reported gap, not a bug</CardTitle>
            <CardDescription>
              Every platform action already writes an append-only audit row (grants, compliance-case
              opens/approvals/closes, and every cross-tenant read) — the writing side is real and
              exercised by this console&apos;s other screens. But `PlatformAuditLogPort`
              (modules/platform-admin/domain/audit.ts) exposes only <code>append</code>; it has no
              list or filter method, so nothing outside that module can read the log back yet.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          The fix is a port change (add a list/query method to
          <code> PlatformAuditLogPort</code> and wire it into <code>ModuleRepositories</code>) —
          <code> modules/**</code> is out of this task&apos;s scope, so it is reported here rather than
          worked around.
        </CardContent>
      </Card>
    </main>
  );
}
