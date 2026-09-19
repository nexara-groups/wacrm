"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Password login. Posts to `/api/auth/login`, which sets the httpOnly
 * session cookie; on success this navigates to `/contacts` and a full
 * reload picks the cookie up for every server-rendered page from there.
 */
export default function LoginPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || (payload as { ok?: boolean }).ok !== true) {
        const message =
          (payload as { error?: { laymanMessage?: string } }).error?.laymanMessage ??
          "Something went wrong. Please try again.";
        setError(message);
        return;
      }
      // Full navigation, not client-side routing: server components (e.g.
      // /contacts) read the session cookie on the next request, and this
      // guarantees that request carries the one the browser just stored.
      window.location.assign("/contacts");
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
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Sign in to your Nexara WACRM account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
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
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
