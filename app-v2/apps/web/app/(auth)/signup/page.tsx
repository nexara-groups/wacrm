"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Self-serve signup — the front door. Posts to `/api/auth/signup`, which
 * creates a brand-new tenant (accounts/users/credentials/memberships, all
 * atomically) and its owner.
 *
 * Deliberately does NOT log the new owner in itself: signup and login stay
 * two separate requests (see `app/api/auth/signup/route.ts`'s header), so
 * on success this redirects to `/login` rather than `/contacts` — the new
 * owner signs in with the password they just chose, same as any returning
 * user would.
 */
export default function SignupPage() {
  const [accountName, setAccountName] = React.useState("");
  const [ownerName, setOwnerName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountName,
          ownerName: ownerName.trim().length > 0 ? ownerName : undefined,
          email,
          password,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || (payload as { ok?: boolean }).ok !== true) {
        const message =
          (payload as { error?: { laymanMessage?: string } }).error?.laymanMessage ??
          "Something went wrong. Please try again.";
        setError(message);
        return;
      }
      // Full navigation: signup does not set a session cookie, so the new
      // owner signs in on /login with the credentials they just created.
      window.location.assign("/login?signedUp=1");
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col justify-center px-4 py-24">
      <Card>
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>Set up a new Nexara WACRM workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="accountName">Business name</Label>
              <Input
                id="accountName"
                name="accountName"
                type="text"
                autoComplete="organization"
                required
                value={accountName}
                onChange={(event) => setAccountName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ownerName">Your name</Label>
              <Input
                id="ownerName"
                name="ownerName"
                type="text"
                autoComplete="name"
                value={ownerName}
                onChange={(event) => setOwnerName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">At least 12 characters.</p>
            </div>
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
