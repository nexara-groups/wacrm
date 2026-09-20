"use client";

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import type { Message } from "@packages/contracts/src/messages";
import type { ListTemplatesResponse, Template } from "@packages/contracts/src/templates";
import type { SendTemplateMessageResponse, SendTextMessageResponse } from "@packages/contracts/src/messages";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  canSend,
  previewTemplateBody,
  sendErrorMessage,
  templateSlots,
  type ComposerMode,
  type ComposerState,
} from "@/lib/composer-state";
import { cn } from "@/lib/utils";

/**
 * The reply box under a thread. All of the "can this be sent, what does a
 * failure mean" logic lives in `@/lib/composer-state` (plain functions, unit
 * tested there) — this component only owns the input state and the two
 * fetches (list approved templates, POST a send).
 */
export function Composer({
  conversationId,
  onSent,
}: {
  conversationId: string;
  onSent: (message: Message) => void;
}) {
  const [mode, setMode] = useState<ComposerMode>("text");
  const [text, setText] = useState("");

  const [templates, setTemplates] = useState<readonly Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesFetched, setTemplatesFetched] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [parameters, setParameters] = useState<readonly string[]>([]);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A composer for thread A must not leak thread A's draft, error or
  // fetched template list into thread B once the operator switches threads.
  useEffect(() => {
    setMode("text");
    setText("");
    setTemplates([]);
    setTemplatesFetched(false);
    setSelectedTemplateId("");
    setParameters([]);
    setSending(false);
    setError(null);
  }, [conversationId]);

  // Fetched once per thread view, only once template mode is actually
  // opened — never on mount, never per keystroke.
  useEffect(() => {
    if (mode !== "template" || templatesFetched) return;
    let cancelled = false;
    setTemplatesLoading(true);
    const params = new URLSearchParams({ status: "approved", pageSize: "200" });
    fetch(`/api/templates?${params.toString()}`)
      .then((res) => res.json() as Promise<ListTemplatesResponse>)
      .then((body) => {
        if (cancelled) return;
        if (body.ok) {
          setTemplates(body.items);
          setTemplatesFetched(true);
        } else {
          setError(body.error.laymanMessage);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, templatesFetched]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  // Re-size the parameter slots whenever the selected template changes —
  // never carry a previous template's parameter values into a new one.
  useEffect(() => {
    if (selectedTemplate === null) {
      setParameters([]);
      return;
    }
    setParameters(Array.from({ length: selectedTemplate.variableCount }, () => ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  function updateParameter(index: number, value: string) {
    setParameters((prev) => prev.map((p, i) => (i === index ? value : p)));
  }

  function switchMode(next: ComposerMode) {
    setMode(next);
    setError(null);
  }

  const composerState: ComposerState = { mode, text, selectedTemplate, parameters };
  const sendEnabled = canSend(composerState) && !sending;

  async function handleSend() {
    if (!canSend(composerState) || sending) return;
    setSending(true);
    setError(null);
    try {
      const res =
        mode === "text"
          ? await fetch(`/api/conversations/${conversationId}/messages/send`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ body: text }),
            })
          : await fetch(`/api/conversations/${conversationId}/messages/template`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                templateId: selectedTemplate!.id,
                languageCode: selectedTemplate!.language,
                parameters,
              }),
            });

      const payload: unknown = await res.json().catch(() => null);
      const body = payload as (SendTextMessageResponse | SendTemplateMessageResponse) | { ok: false } | null;

      if (!res.ok || body === null || body.ok !== true) {
        // Never optimistically appear in the thread, and never clear the
        // operator's draft — a blocked send should not also cost them their
        // typed text.
        setError(sendErrorMessage(res.status, payload));
        return;
      }

      onSent(body.message);
      if (mode === "text") {
        setText("");
      } else if (selectedTemplate !== null) {
        setParameters(Array.from({ length: selectedTemplate.variableCount }, () => ""));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  const approvedTemplates = templates.filter((t) => t.status === "approved");

  return (
    <div className="border-t border-border p-3">
      <div className="mb-2 flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant={mode === "text" ? "default" : "outline"}
          onClick={() => switchMode("text")}
          disabled={sending}
        >
          Text
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "template" ? "default" : "outline"}
          onClick={() => switchMode("template")}
          disabled={sending}
        >
          Template
        </Button>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {mode === "text" ? (
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            disabled={sending}
            className="max-h-40"
          />
          <Button type="button" onClick={handleSend} disabled={!sendEnabled}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {templatesLoading ? (
            <p className="text-xs text-muted-foreground">Loading templates…</p>
          ) : approvedTemplates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No approved templates available.</p>
          ) : (
            <Select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              disabled={sending}
            >
              <option value="">Select a template…</option>
              {approvedTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} ({template.language})
                </option>
              ))}
            </Select>
          )}

          {selectedTemplate !== null && (
            <>
              {templateSlots(selectedTemplate).length > 0 && (
                <div className={cn("grid gap-2", "sm:grid-cols-2")}>
                  {templateSlots(selectedTemplate).map((slot) => (
                    <div key={slot}>
                      <Label htmlFor={`template-param-${slot}`}>Parameter {slot}</Label>
                      <Input
                        id={`template-param-${slot}`}
                        value={parameters[slot - 1] ?? ""}
                        onChange={(e) => updateParameter(slot - 1, e.target.value)}
                        disabled={sending}
                        className="mt-1"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
                {previewTemplateBody(selectedTemplate, parameters)}
              </div>
            </>
          )}

          <div className="flex justify-end">
            <Button type="button" onClick={handleSend} disabled={!sendEnabled}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
