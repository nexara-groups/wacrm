"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Send, X } from "lucide-react";
import type { Message } from "@packages/contracts/src/messages";
import type { ListTemplatesResponse, Template } from "@packages/contracts/src/templates";
import type {
  SendInteractiveMessageResponse,
  SendMediaMessageResponse,
  SendTemplateMessageResponse,
  SendTextMessageResponse,
} from "@packages/contracts/src/messages";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  canSend,
  emptyInteractiveState,
  emptyMediaState,
  INTERACTIVE_BUTTON_TITLE_MAX_LENGTH,
  INTERACTIVE_LIST_BUTTON_LABEL_MAX_LENGTH,
  INTERACTIVE_LIST_ROW_DESCRIPTION_MAX_LENGTH,
  INTERACTIVE_LIST_ROW_TITLE_MAX_LENGTH,
  INTERACTIVE_LIST_SECTION_TITLE_MAX_LENGTH,
  INTERACTIVE_MAX_BUTTONS,
  INTERACTIVE_MAX_LIST_ROWS,
  MEDIA_CAPTION_MAX_LENGTH,
  MEDIA_FILE_NAME_MAX_LENGTH,
  mediaKindOf,
  mediaNeedsUpload,
  previewTemplateBody,
  sendErrorMessage,
  templateSlots,
  toInteractiveSendPayload,
  toMediaSendPayload,
  type ComposerMode,
  type ComposerState,
  type InteractiveState,
  type MediaState,
} from "@/lib/composer-state";
import { cn } from "@/lib/utils";

/**
 * The reply box under a thread. All of the "can this be sent, what does a
 * failure mean" logic lives in `@/lib/composer-state` (plain functions, unit
 * tested there) — this component only owns the input state and the
 * fetches (list approved templates, upload a file, POST a send).
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

  const [media, setMedia] = useState<MediaState>(emptyMediaState());
  // The actual picked `File` — kept out of `MediaState` (composer-state.ts's
  // pure, node-testable data) since a `File` object can't cross that
  // boundary; only what the pure validators need (its name/MIME type) is
  // mirrored into `media`.
  const [pickedFile, setPickedFile] = useState<File | null>(null);

  const [interactive, setInteractive] = useState<InteractiveState>(emptyInteractiveState());

  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
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
    setMedia(emptyMediaState());
    setPickedFile(null);
    setInteractive(emptyInteractiveState());
    setSending(false);
    setUploading(false);
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

  function handleFilePicked(file: File | null) {
    setPickedFile(file);
    setMedia((prev) => ({
      ...prev,
      hasFile: file !== null,
      fileMimeType: file?.type ?? null,
      // A different file invalidates any previous upload — never send a
      // stale mediaId that belonged to the last file under a new one.
      uploadedMediaId: null,
      fileName: file?.name ?? prev.fileName,
    }));
  }

  const mediaKind = mediaKindOf(media);

  const composerState: ComposerState = { mode, text, selectedTemplate, parameters, media, interactive };
  const sendEnabled = canSend(composerState) && !sending && !uploading;

  /** Uploads the picked file via `POST /api/media` and returns the resulting mediaId, or null on failure (with `error` already set). */
  async function uploadPickedFile(): Promise<string | null> {
    if (pickedFile === null) return null;
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", pickedFile);
      const res = await fetch("/api/media", { method: "POST", body: form });
      const payload: unknown = await res.json().catch(() => null);
      const body = payload as { ok: true; mediaId: string } | { ok: false } | null;
      if (!res.ok || body === null || body.ok !== true) {
        setError(sendErrorMessage(res.status, payload));
        return null;
      }
      setMedia((prev) => ({ ...prev, uploadedMediaId: body.mediaId }));
      return body.mediaId;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function handleSend() {
    if (!canSend(composerState) || sending || uploading) return;
    setError(null);

    if (mode === "media") {
      // Upload (if needed) and send are two separate requests — a send
      // that fails after a successful upload must not re-upload the same
      // bytes on retry, which is exactly why `uploadedMediaId` lives in
      // `media` state rather than being re-derived each attempt.
      let current = media;
      if (mediaNeedsUpload(current)) {
        const mediaId = await uploadPickedFile();
        if (mediaId === null) return; // error already set by uploadPickedFile
        current = { ...current, uploadedMediaId: mediaId };
      }
      const payload = toMediaSendPayload(current);
      if (payload === null) return;

      setSending(true);
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages/media`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const responsePayload: unknown = await res.json().catch(() => null);
        const body = responsePayload as SendMediaMessageResponse | { ok: false } | null;
        if (!res.ok || body === null || body.ok !== true) {
          // Keep the picked file and its `uploadedMediaId` — only the
          // send failed, not the upload.
          setError(sendErrorMessage(res.status, responsePayload));
          return;
        }
        onSent(body.message);
        setMedia(emptyMediaState());
        setPickedFile(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
      return;
    }

    if (mode === "interactive") {
      const payload = toInteractiveSendPayload(interactive);
      if (payload === null) return;

      setSending(true);
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages/interactive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const responsePayload: unknown = await res.json().catch(() => null);
        const body = responsePayload as SendInteractiveMessageResponse | { ok: false } | null;
        if (!res.ok || body === null || body.ok !== true) {
          setError(sendErrorMessage(res.status, responsePayload));
          return;
        }
        onSent(body.message);
        setInteractive(emptyInteractiveState());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
      return;
    }

    setSending(true);
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
  const busy = sending || uploading;

  return (
    <div className="border-t border-border p-3">
      <div className="mb-2 flex items-center gap-1">
        <Button type="button" size="sm" variant={mode === "text" ? "default" : "outline"} onClick={() => switchMode("text")} disabled={busy}>
          Text
        </Button>
        <Button type="button" size="sm" variant={mode === "template" ? "default" : "outline"} onClick={() => switchMode("template")} disabled={busy}>
          Template
        </Button>
        <Button type="button" size="sm" variant={mode === "media" ? "default" : "outline"} onClick={() => switchMode("media")} disabled={busy}>
          Media
        </Button>
        <Button type="button" size="sm" variant={mode === "interactive" ? "default" : "outline"} onClick={() => switchMode("interactive")} disabled={busy}>
          Interactive
        </Button>
      </div>

      {error && (
        <p className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {mode === "text" && (
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            disabled={busy}
            className="max-h-40"
          />
          <Button type="button" onClick={handleSend} disabled={!sendEnabled}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </div>
      )}

      {mode === "template" && (
        <div className="space-y-2">
          {templatesLoading ? (
            <p className="text-xs text-muted-foreground">Loading templates…</p>
          ) : approvedTemplates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No approved templates available.</p>
          ) : (
            <Select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)} disabled={busy}>
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
                        disabled={busy}
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

      {mode === "media" && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={media.source === "file" ? "default" : "outline"}
              onClick={() => setMedia((prev) => ({ ...prev, source: "file" }))}
              disabled={busy}
            >
              Upload a file
            </Button>
            <Button
              type="button"
              size="sm"
              variant={media.source === "url" ? "default" : "outline"}
              onClick={() => setMedia((prev) => ({ ...prev, source: "url" }))}
              disabled={busy}
            >
              Use a URL
            </Button>
          </div>

          {/* Exactly one of these two blocks is ever rendered — the operator
              can never populate both a file and a URL at once. */}
          {media.source === "file" ? (
            <div className="space-y-2">
              <Input
                type="file"
                onChange={(e) => handleFilePicked(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
              {pickedFile !== null && mediaKind === null && (
                <p className="text-xs text-destructive">
                  This file type ({pickedFile.type || "unknown"}) isn't supported.
                </p>
              )}
              {pickedFile !== null && mediaKind !== null && (
                <p className="text-xs text-muted-foreground">Detected type: {mediaKind}</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                value={media.mediaUrl}
                onChange={(e) => setMedia((prev) => ({ ...prev, mediaUrl: e.target.value }))}
                placeholder="https://…"
                disabled={busy}
              />
              <div>
                <Label htmlFor="media-url-kind">Type</Label>
                {/* Only the port's four sendable kinds — "sticker" is never
                    offered; the send route 422s for it (see the send
                    route's header comment). */}
                <Select
                  id="media-url-kind"
                  value={media.urlKind ?? ""}
                  onChange={(e) =>
                    setMedia((prev) => ({
                      ...prev,
                      urlKind: (e.target.value || null) as MediaState["urlKind"],
                    }))
                  }
                  disabled={busy}
                  className="mt-1"
                >
                  <option value="">Select a type…</option>
                  <option value="image">Image</option>
                  <option value="video">Video</option>
                  <option value="audio">Audio</option>
                  <option value="document">Document</option>
                </Select>
              </div>
            </div>
          )}

          {mediaKind === "document" && (
            <div>
              <Label htmlFor="media-filename">File name</Label>
              <Input
                id="media-filename"
                value={media.fileName}
                onChange={(e) => setMedia((prev) => ({ ...prev, fileName: e.target.value }))}
                disabled={busy}
                maxLength={MEDIA_FILE_NAME_MAX_LENGTH}
                className="mt-1"
              />
            </div>
          )}

          <div>
            <Label htmlFor="media-caption">Caption (optional)</Label>
            <Textarea
              id="media-caption"
              value={media.caption}
              onChange={(e) => setMedia((prev) => ({ ...prev, caption: e.target.value }))}
              disabled={busy}
              maxLength={MEDIA_CAPTION_MAX_LENGTH}
              className="mt-1 max-h-32"
            />
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={handleSend} disabled={!sendEnabled}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {uploading ? "Uploading…" : "Send"}
            </Button>
          </div>
        </div>
      )}

      {mode === "interactive" && (
        <div className="space-y-2">
          <Textarea
            value={interactive.bodyText}
            onChange={(e) => setInteractive((prev) => ({ ...prev, bodyText: e.target.value }))}
            placeholder="Message body…"
            disabled={busy}
            className="max-h-32"
          />

          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={interactive.kind === "button" ? "default" : "outline"}
              onClick={() => setInteractive((prev) => ({ ...prev, kind: "button" }))}
              disabled={busy}
            >
              Buttons
            </Button>
            <Button
              type="button"
              size="sm"
              variant={interactive.kind === "list" ? "default" : "outline"}
              onClick={() => setInteractive((prev) => ({ ...prev, kind: "list" }))}
              disabled={busy}
            >
              List
            </Button>
          </div>

          {interactive.kind === "button" ? (
            <div className="space-y-2">
              {interactive.buttons.map((button, index) => (
                <div key={index} className="flex items-end gap-2">
                  <div className="flex-1">
                    <Label htmlFor={`btn-id-${index}`}>Button id</Label>
                    <Input
                      id={`btn-id-${index}`}
                      value={button.id}
                      onChange={(e) =>
                        setInteractive((prev) => ({
                          ...prev,
                          buttons: prev.buttons.map((b, i) => (i === index ? { ...b, id: e.target.value } : b)),
                        }))
                      }
                      disabled={busy}
                      maxLength={256}
                      className="mt-1"
                    />
                  </div>
                  <div className="flex-1">
                    <Label htmlFor={`btn-title-${index}`}>Title (≤{INTERACTIVE_BUTTON_TITLE_MAX_LENGTH})</Label>
                    <Input
                      id={`btn-title-${index}`}
                      value={button.title}
                      onChange={(e) =>
                        setInteractive((prev) => ({
                          ...prev,
                          buttons: prev.buttons.map((b, i) => (i === index ? { ...b, title: e.target.value } : b)),
                        }))
                      }
                      disabled={busy}
                      maxLength={INTERACTIVE_BUTTON_TITLE_MAX_LENGTH}
                      className="mt-1"
                    />
                  </div>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      setInteractive((prev) => ({ ...prev, buttons: prev.buttons.filter((_, i) => i !== index) }))
                    }
                    disabled={busy}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
              {interactive.buttons.length < INTERACTIVE_MAX_BUTTONS && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setInteractive((prev) => ({ ...prev, buttons: [...prev.buttons, { id: "", title: "" }] }))
                  }
                  disabled={busy}
                >
                  <Plus className="size-4" />
                  Add button
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div>
                <Label htmlFor="list-button-label">Button label (≤{INTERACTIVE_LIST_BUTTON_LABEL_MAX_LENGTH})</Label>
                <Input
                  id="list-button-label"
                  value={interactive.listButtonLabel}
                  onChange={(e) => setInteractive((prev) => ({ ...prev, listButtonLabel: e.target.value }))}
                  disabled={busy}
                  maxLength={INTERACTIVE_LIST_BUTTON_LABEL_MAX_LENGTH}
                  className="mt-1"
                />
              </div>
              <div>
                {/* `interactiveListSectionSchema` supports several sections;
                    this UI exposes only one — a UI limitation, not a
                    contract one (see composer-state.ts's header comment on
                    interactive mode). */}
                <Label htmlFor="list-section-title">
                  Section title (≤{INTERACTIVE_LIST_SECTION_TITLE_MAX_LENGTH})
                </Label>
                <Input
                  id="list-section-title"
                  value={interactive.listSectionTitle}
                  onChange={(e) => setInteractive((prev) => ({ ...prev, listSectionTitle: e.target.value }))}
                  disabled={busy}
                  maxLength={INTERACTIVE_LIST_SECTION_TITLE_MAX_LENGTH}
                  className="mt-1"
                />
              </div>

              {interactive.listRows.map((row, index) => (
                <div key={index} className="space-y-1 rounded-lg border border-border p-2">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label htmlFor={`row-id-${index}`}>Row id</Label>
                      <Input
                        id={`row-id-${index}`}
                        value={row.id}
                        onChange={(e) =>
                          setInteractive((prev) => ({
                            ...prev,
                            listRows: prev.listRows.map((r, i) => (i === index ? { ...r, id: e.target.value } : r)),
                          }))
                        }
                        disabled={busy}
                        maxLength={200}
                        className="mt-1"
                      />
                    </div>
                    <div className="flex-1">
                      <Label htmlFor={`row-title-${index}`}>Title (≤{INTERACTIVE_LIST_ROW_TITLE_MAX_LENGTH})</Label>
                      <Input
                        id={`row-title-${index}`}
                        value={row.title}
                        onChange={(e) =>
                          setInteractive((prev) => ({
                            ...prev,
                            listRows: prev.listRows.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)),
                          }))
                        }
                        disabled={busy}
                        maxLength={INTERACTIVE_LIST_ROW_TITLE_MAX_LENGTH}
                        className="mt-1"
                      />
                    </div>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() =>
                        setInteractive((prev) => ({ ...prev, listRows: prev.listRows.filter((_, i) => i !== index) }))
                      }
                      disabled={busy}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div>
                    <Label htmlFor={`row-desc-${index}`}>
                      Description (optional, ≤{INTERACTIVE_LIST_ROW_DESCRIPTION_MAX_LENGTH})
                    </Label>
                    <Input
                      id={`row-desc-${index}`}
                      value={row.description}
                      onChange={(e) =>
                        setInteractive((prev) => ({
                          ...prev,
                          listRows: prev.listRows.map((r, i) =>
                            i === index ? { ...r, description: e.target.value } : r,
                          ),
                        }))
                      }
                      disabled={busy}
                      maxLength={INTERACTIVE_LIST_ROW_DESCRIPTION_MAX_LENGTH}
                      className="mt-1"
                    />
                  </div>
                </div>
              ))}
              {interactive.listRows.length < INTERACTIVE_MAX_LIST_ROWS && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setInteractive((prev) => ({
                      ...prev,
                      listRows: [...prev.listRows, { id: "", title: "", description: "" }],
                    }))
                  }
                  disabled={busy}
                >
                  <Plus className="size-4" />
                  Add row
                </Button>
              )}
            </div>
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
