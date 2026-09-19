import { ShieldX } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The refusal every `app/platform/**` page renders when the signed-in user
 * holds no active platform-role grant. A tenant owner/admin/manager/member
 * (any tenant role, any account) sees exactly this and nothing else —
 * never a glimpse of the console, never a hint at what it contains.
 */
export function PlatformDenied() {
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <Card className="border-destructive/30">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <ShieldX className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div>
            <CardTitle>Platform console — access denied</CardTitle>
            <CardDescription>
              This account holds no platform role. The platform console is for Nexara staff only — a
              tenant role (owner, admin, manager, member) never grants platform access; the two are
              separate, orthogonal axes by design.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            If you believe you should have platform access, ask a platform_superadmin to grant it — that
            grant itself requires a second platform_superadmin&apos;s approval and is fully audited.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
