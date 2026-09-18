"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import type {
  AudienceFilter,
  AudiencePreview,
  CreateBroadcastResponse,
  PreviewAudienceResponse,
} from "@packages/contracts/src/broadcasts";
import type { Template } from "@packages/contracts/src/templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AudiencePreviewCard } from "@/components/broadcasts/audience-preview-card";

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function buildAudienceFilter(search: string, tagsRaw: string): AudienceFilter {
  const tags = parseTags(tagsRaw);
  return {
    ...(search.trim().length > 0 ? { search: search.trim() } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function BroadcastComposer({ templates }: { templates: readonly Template[] }) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");

  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handlePreview() {
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch("/api/broadcasts/preview-audience", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audienceFilter: buildAudienceFilter(search, tagsRaw) }),
      });
      const body = (await res.json()) as PreviewAudienceResponse;
      if (!body.ok) {
        setError(body.error.laymanMessage);
        return;
      }
      setPreview(body.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCreate(scheduleNow: boolean) {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/broadcasts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          templateId,
          audienceFilter: buildAudienceFilter(search, tagsRaw),
          scheduledAt: scheduleNow && scheduledAt ? new Date(scheduledAt).toISOString() : null,
        }),
      });
      const body = (await res.json()) as CreateBroadcastResponse;
      if (!body.ok) {
        setFieldErrors(body.error.fieldErrors ?? {});
        setError(body.error.laymanMessage);
        return;
      }
      router.push(`/broadcasts/${body.broadcast.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = name.trim().length > 0 && templateId.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New broadcast</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a template and audience, preview exactly who will be skipped and why, then save as a draft or schedule
          it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="broadcast-name">Name</Label>
            <Input
              id="broadcast-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. September re-engagement"
              className="mt-1"
            />
            {fieldErrors.name && <p className="mt-1 text-xs text-destructive">{fieldErrors.name[0]}</p>}
          </div>

          <div>
            <Label htmlFor="broadcast-template">Template</Label>
            {templates.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No message templates yet — approve one in WhatsApp settings first.
              </p>
            ) : (
              <Select
                id="broadcast-template"
                className="mt-1"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} ({template.language}) — {template.status}
                  </option>
                ))}
              </Select>
            )}
            {fieldErrors.templateId && <p className="mt-1 text-xs text-destructive">{fieldErrors.templateId[0]}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audience</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="audience-search">Search (name, phone, email)</Label>
              <Input
                id="audience-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Optional"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="audience-tags">Tags (comma-separated)</Label>
              <Input
                id="audience-tags"
                value={tagsRaw}
                onChange={(e) => setTagsRaw(e.target.value)}
                placeholder="e.g. vip, mumbai"
                className="mt-1"
              />
            </div>
          </div>

          <Button type="button" variant="outline" onClick={handlePreview} disabled={previewing}>
            {previewing && <Loader2 className="size-4 animate-spin" />}
            Preview audience
          </Button>

          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {preview && <AudiencePreviewCard preview={preview} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Send timing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs">
            <Label htmlFor="broadcast-scheduled-at">Schedule for (optional)</Label>
            <Input
              id="broadcast-scheduled-at"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="mt-1"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => handleCreate(false)} disabled={!canSubmit || submitting} variant="outline">
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Save as draft
            </Button>
            <Button
              type="button"
              onClick={() => handleCreate(true)}
              disabled={!canSubmit || submitting || scheduledAt.length === 0}
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Schedule broadcast
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
