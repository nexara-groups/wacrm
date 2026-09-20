import { describe, expect, it, vi } from "vitest";
import { broadcastIdSchema } from "@packages/contracts/src/index";
import type { ApiClientContext, FetchLike } from "../http";
import { createBroadcastsResource } from "./broadcasts";

const BROADCAST_ID = broadcastIdSchema.parse("3fa85f64-5717-4562-b3fc-2c963f66afa6");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeCtx(fetchFn: FetchLike): ApiClientContext {
  return { baseUrl: "https://api.example.test", fetchFn, headers: {} };
}

describe("broadcasts resource — audience preview", () => {
  it("keeps skippedGroups grouped by reason with counts intact through the round trip (never flattened)", async () => {
    const preview = {
      totalMatchedCount: 3142,
      willSendCount: 2962,
      skippedCount: 180,
      skippedGroups: [
        { reason: "suppressed_number", count: 142, label: "can't receive WhatsApp messages" },
        { reason: "opted_out", count: 38, label: "opted out of messages" },
      ],
      summary: "3,142 recipients · 180 will be skipped (142 can't receive · 38 opted out)",
    };
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, preview }));
    const broadcasts = createBroadcastsResource(makeCtx(fetchFn));

    const result = await broadcasts.previewAudience({ audienceFilter: { tags: ["vip"] } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Structural equality — the grouped shape (an array of {reason,count,label}) must survive verbatim, not collapse into a flat count or a list of contact ids.
      expect(result.value.preview).toEqual(preview);
      expect(result.value.preview.skippedGroups).toHaveLength(2);
      expect(result.value.preview.skippedGroups[0]).toEqual({
        reason: "suppressed_number",
        count: 142,
        label: "can't receive WhatsApp messages",
      });
      expect(result.value.preview.skippedGroups[1]).toEqual({
        reason: "opted_out",
        count: 38,
        label: "opted out of messages",
      });
      // The invariant the group counts encode: they sum to skippedCount, which in turn plus willSendCount equals totalMatchedCount.
      const groupSum = result.value.preview.skippedGroups.reduce((sum, group) => sum + group.count, 0);
      expect(groupSum).toBe(result.value.preview.skippedCount);
      expect(result.value.preview.willSendCount + result.value.preview.skippedCount).toBe(
        result.value.preview.totalMatchedCount,
      );
    }
  });

  it("rejects a preview whose group counts don't sum correctly, at the client boundary (zod's own .refine())", async () => {
    const brokenPreview = {
      totalMatchedCount: 100,
      willSendCount: 90,
      skippedCount: 10,
      skippedGroups: [{ reason: "opted_out", count: 1, label: "opted out" }], // sums to 1, not 10
      summary: "100 recipients",
    };
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, preview: brokenPreview }));
    const broadcasts = createBroadcastsResource(makeCtx(fetchFn));

    const result = await broadcasts.previewAudience({ audienceFilter: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("parse");
  });

  it("report() keeps failureGroups grouped by code/disposition with counts intact", async () => {
    const report = {
      broadcast: {
        id: BROADCAST_ID,
        accountId: "4fa85f64-5717-4562-b3fc-2c963f66afa6",
        name: "Diwali sale",
        templateId: "5fa85f64-5717-4562-b3fc-2c963f66afa6",
        status: "sent",
        scheduledAt: null,
        createdBy: "6fa85f64-5717-4562-b3fc-2c963f66afa6",
        totalRecipients: 200,
        sentCount: 180,
        failedCount: 20,
        pausedAt: null,
        pauseReason: null,
        skippedCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      sentCount: 180,
      deliveredCount: 150,
      readCount: 90,
      failedCount: 20,
      pendingCount: 0,
      willRetryCount: 8,
      failureGroups: [
        { code: "131026", disposition: "PERMANENT_NUMBER", laymanMessage: "Couldn't receive WhatsApp messages.", count: 12 },
        { code: "NETWORK", disposition: "TRANSIENT", laymanMessage: "Temporary delivery issue — will retry automatically.", count: 8 },
      ],
    };
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, report }));
    const broadcasts = createBroadcastsResource(makeCtx(fetchFn));

    const result = await broadcasts.report({ broadcastId: BROADCAST_ID });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.report.failureGroups).toEqual(report.failureGroups);
      expect(result.value.report.failureGroups).toHaveLength(2);
    }
  });
});
