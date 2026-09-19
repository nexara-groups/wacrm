/**
 * `/platform/compliance-cases` — server-gated wrapper around the client
 * screen. See `components/platform/compliance-cases-screen.tsx` for the
 * actual UI; this file's only job is the access-seam check every
 * `app/platform/**` page repeats (see `app/platform/page.tsx`'s header)
 * plus handing the client screen the caller's own tier, so it can hide
 * actions the server would refuse anyway (a UX nicety — the routes
 * themselves are the real enforcement, per this task's HARD RULE 6).
 */
import { platformRoleAtLeast } from "@nexara/core/rbac";
import { getPlatformPrincipal } from "@/lib/platform-principal";
import { toPlatformPrincipalSummaryDTO } from "@/lib/platform-dto";
import { PlatformDenied } from "@/components/platform/platform-denied";
import { ComplianceCasesScreen } from "@/components/platform/compliance-cases-screen";

export const dynamic = "force-dynamic";

export default async function PlatformComplianceCasesPage() {
  const principal = await getPlatformPrincipal();
  if (principal === null) {
    return <PlatformDenied />;
  }

  const summary = toPlatformPrincipalSummaryDTO(principal);
  const canOpenOrDecide = platformRoleAtLeast(principal.platformRole, "platform_admin");

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <ComplianceCasesScreen viewerEmail={summary.email} canOpenOrDecide={canOpenOrDecide} />
    </main>
  );
}
