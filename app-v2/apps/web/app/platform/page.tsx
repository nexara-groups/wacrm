/**
 * `/platform` — the console home.
 *
 * `proxy.ts` (off limits to this task) only confirms a session COOKIE is
 * present for any non-public path — it has no notion of a platform role at
 * all (see its own file header: "confirms a session cookie is PRESENT ...
 * not the only check"). So this page, like every route in this console,
 * calls `getPlatformPrincipal()` itself and refuses outright when the
 * signed-in user holds no active platform-role grant — a tenant owner
 * landing here (e.g. by guessing the URL) sees exactly this refusal, never
 * the console.
 */
import Link from "next/link";
import { ShieldAlert, ShieldCheck, FileSearch, ScrollText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPlatformPrincipal } from "@/lib/platform-principal";
import { toPlatformPrincipalSummaryDTO } from "@/lib/platform-dto";
import { PlatformDenied } from "@/components/platform/platform-denied";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<string, string> = {
  platform_support: "Platform Support",
  platform_admin: "Platform Admin",
  platform_superadmin: "Platform Super Admin",
};

export default async function PlatformHomePage() {
  const principal = await getPlatformPrincipal();
  if (principal === null) {
    return <PlatformDenied />;
  }

  const summary = toPlatformPrincipalSummaryDTO(principal);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Platform Console</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{summary.email}</span>
          </p>
        </div>
        <Badge variant="secondary">{TIER_LABEL[summary.platformRole] ?? summary.platformRole}</Badge>
      </div>

      <Card className="mb-6 border-amber-500/30 bg-amber-500/5">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <CardTitle>What this console will never show you</CardTitle>
            <CardDescription>
              No screen here lists a customer&apos;s message bodies. There is no &quot;open this
              account&apos;s inbox&quot; anywhere, at any tier — including yours. Content is reachable
              only inside an approved, scoped, expiring compliance case, and only for the specific
              evidence that case names. Every attempt to read content — allowed or denied — is logged.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/platform/compliance-cases">
          <Card className="h-full transition-colors hover:border-primary/50">
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <FileSearch className="size-4 shrink-0 text-muted-foreground" />
              <div>
                <CardTitle>Compliance cases</CardTitle>
                <CardDescription>
                  Open a scoped, time-boxed case to answer Meta. Approve (two-person rule), close, and
                  see what is currently active.
                </CardDescription>
              </div>
            </CardHeader>
          </Card>
        </Link>

        <Link href="/platform/audit">
          <Card className="h-full transition-colors hover:border-primary/50">
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <ScrollText className="size-4 shrink-0 text-muted-foreground" />
              <div>
                <CardTitle>Audit log</CardTitle>
                <CardDescription>Who did what, to which account, when, and why.</CardDescription>
              </div>
            </CardHeader>
          </Card>
        </Link>
      </div>

      <Card className="mt-6">
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
          <CardTitle>Your capabilities at this tier</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {summary.capabilities.map((capability) => (
              <Badge key={capability} variant="outline">
                {capability}
              </Badge>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tiers are cumulative: {TIER_LABEL[summary.platformRole] ?? summary.platformRole} can do
            everything a lower tier can, plus what is listed above. Fleet overview, billing ops and
            support-tool screens are not built into this console yet — see the delivery report for why
            (no rollup table / account status columns exist behind those ports).
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
