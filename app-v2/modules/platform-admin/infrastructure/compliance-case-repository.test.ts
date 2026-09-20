import { beforeEach, describe, expect, it } from "vitest";
import type { VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import type { TenantContext } from "@nexara/core/context";
import type { ContactId, ConversationId, MessageId } from "@packages/domain";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlConversationRepository } from "../../conversations/infrastructure/conversation-repository";
import { SqlMessageRepository } from "../../conversations/infrastructure/message-repository";
import { SqlPlatformAuditLogRepository } from "./audit-log-repository";
import { SqlComplianceCaseRepository } from "./compliance-case-repository";
import type { ComplianceResourceRef } from "../domain/compliance-case";

const OPENER: VerifiedPlatformPrincipal = {
  userId: "staff-opener",
  tenantId: "n/a",
  email: "opener@nexara.test",
  platformRole: "platform_admin",
};
const APPROVER: VerifiedPlatformPrincipal = {
  userId: "staff-approver",
  tenantId: "n/a",
  email: "approver@nexara.test",
  platformRole: "platform_superadmin",
};

const ACCOUNT = "acct-under-investigation" as unknown as TenantContext["tenantId"];
const TENANT: TenantContext = { tenantId: ACCOUNT };
const contact = (id: string) => id as unknown as ContactId;
const conversation = (id: string) => id as unknown as ConversationId;
const messageId = (id: string) => id as unknown as MessageId;

let db: SqlJsDatabaseProvider;
let repo: SqlComplianceCaseRepository;
let auditLog: SqlPlatformAuditLogRepository;
let conversations: SqlConversationRepository;
let messages: SqlMessageRepository;
let convId: ConversationId;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlComplianceCaseRepository(db);
  auditLog = new SqlPlatformAuditLogRepository(db);
  conversations = new SqlConversationRepository(db);
  messages = new SqlMessageRepository(db);

  convId = (
    await conversations.create(TENANT, { id: conversation("conv-1"), contactId: contact("contact-1"), now: "t0" })
  ).id as ConversationId;

  await messages.insert(TENANT, {
    id: messageId("msg-evidence-1"),
    conversationId: convId,
    contactId: contact("contact-1"),
    direction: "inbound",
    type: "text",
    body: "here is my complaint about the last order",
    templateId: null,
    waMessageId: null,
    replyToId: null,
    mediaRef: null,
    status: "delivered",
    occurredAt: "2026-09-01T00:00:00.000Z",
  });
  await messages.insert(TENANT, {
    id: messageId("msg-out-of-scope"),
    conversationId: convId,
    contactId: contact("contact-1"),
    direction: "outbound",
    type: "text",
    body: "an unrelated private message never named in the case",
    templateId: null,
    waMessageId: null,
    replyToId: null,
    mediaRef: null,
    status: "sent",
    occurredAt: "2026-09-01T00:05:00.000Z",
  });
});

const NOW = new Date("2026-09-18T00:00:00.000Z");

async function openScopedCase(overrides: Partial<Parameters<typeof repo.open>[1]> = {}) {
  return repo.open(OPENER, {
    id: "case-1",
    externalRef: "meta-complaint-42",
    category: "user_complaint",
    accountId: ACCOUNT,
    scope: { scopeType: "message_ids", scopeValue: { messageIds: ["msg-evidence-1"] } },
    reason: "Meta raised a user complaint about this exact message",
    ...overrides,
  });
}

describe("SqlComplianceCaseRepository — real schema (0004_platform_admin.sql) — THE central invariant", () => {
  it("opening a case grants nothing: readContent for its own scoped resource returns null before approval", async () => {
    await openScopedCase();
    const ref: ComplianceResourceRef = { type: "message_ids", messageId: "msg-evidence-1" };

    const content = await repo.readContent(OPENER, "case-1", ref, NOW);
    expect(content).toBeNull();

    // But the attempt is still recorded — every read, successful or not.
    const { rows } = await db.query(
      `-- tenant-scope-exempt: test assertion against the append-only case-read trail, keyed by case id
       select * from compliance_case_reads where case_id = $1`,
      ["case-1"],
    );
    expect(rows).toHaveLength(1);
  });

  it("two-person rule: the opener cannot approve their own case", async () => {
    await openScopedCase();
    await expect(repo.approve(OPENER, "case-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("APPROVED + in-scope resourceRef: readContent returns the real message content — the one sanctioned path", async () => {
    await openScopedCase();
    await repo.approve(APPROVER, "case-1");

    const ref: ComplianceResourceRef = { type: "message_ids", messageId: "msg-evidence-1" };
    const content = await repo.readContent(OPENER, "case-1", ref, NOW);

    expect(content).toMatchObject({
      id: "msg-evidence-1",
      body: "here is my complaint about the last order",
    });
  });

  it("APPROVED but OUT-OF-SCOPE resourceRef: readContent still returns null — no browsing even inside an open case", async () => {
    await openScopedCase(); // scope: only msg-evidence-1
    await repo.approve(APPROVER, "case-1");

    const outOfScopeRef: ComplianceResourceRef = { type: "message_ids", messageId: "msg-out-of-scope" };
    const content = await repo.readContent(OPENER, "case-1", outOfScopeRef, NOW);

    expect(content).toBeNull();
  });

  it("EXPIRED case: readContent denies access even though the row still says open (no cleanup job required)", async () => {
    await openScopedCase();
    const approved = await repo.approve(APPROVER, "case-1", 1); // 1-day TTL
    const afterExpiry = new Date(new Date(approved.expiresAt as string).getTime() + 1000);

    const ref: ComplianceResourceRef = { type: "message_ids", messageId: "msg-evidence-1" };
    expect(await repo.readContent(OPENER, "case-1", ref, afterExpiry)).toBeNull();
  });

  it("CLOSED case: readContent denies access immediately, regardless of expiresAt", async () => {
    await openScopedCase();
    await repo.approve(APPROVER, "case-1");
    await repo.close(APPROVER, "case-1", "resolved with Meta");

    const ref: ComplianceResourceRef = { type: "message_ids", messageId: "msg-evidence-1" };
    expect(await repo.readContent(OPENER, "case-1", ref, NOW)).toBeNull();
  });

  it("readContent for a nonexistent case audits the attempt and returns null without touching compliance_case_reads", async () => {
    const ref: ComplianceResourceRef = { type: "message_ids", messageId: "msg-evidence-1" };
    const content = await repo.readContent(OPENER, "no-such-case", ref, NOW);
    expect(content).toBeNull();

    const { rows } = await db.query(
      `-- tenant-scope-exempt: test assertion against the append-only case-read trail
       select * from compliance_case_reads`,
      [],
    );
    expect(rows).toHaveLength(0);
    const entries = await auditLog.listAll();
    expect(entries.some((e) => e.action === "compliance_case:read_content:case_not_found")).toBe(true);
  });

  it("every read (granted or denied) appends a platform_audit_log entry — reading across tenants is itself audited", async () => {
    await openScopedCase();
    await repo.approve(APPROVER, "case-1");
    const ref: ComplianceResourceRef = { type: "message_ids", messageId: "msg-evidence-1" };
    const outOfScopeRef: ComplianceResourceRef = { type: "message_ids", messageId: "msg-out-of-scope" };

    await repo.readContent(OPENER, "case-1", ref, NOW);
    await repo.readContent(OPENER, "case-1", outOfScopeRef, NOW);

    const entries = await auditLog.listAll();
    expect(entries.some((e) => e.action === "compliance_case:read_content:granted")).toBe(true);
    expect(entries.some((e) => e.action === "compliance_case:read_content:denied")).toBe(true);
  });

  it("findActiveForAccount lists open cases and stops listing a closed one", async () => {
    await openScopedCase();
    expect(await repo.findActiveForAccount(OPENER, ACCOUNT)).toHaveLength(1);

    await repo.approve(APPROVER, "case-1");
    await repo.close(APPROVER, "case-1", "resolved");
    expect(await repo.findActiveForAccount(OPENER, ACCOUNT)).toHaveLength(0);
  });

  it("recordExport writes a watermarked export row and audits it", async () => {
    await openScopedCase();
    await repo.approve(APPROVER, "case-1");

    await repo.recordExport(OPENER, {
      caseId: "case-1",
      actorUserId: OPENER.userId,
      format: "csv",
      watermark: "case-1/staff-opener/2026-09-18",
      rowCount: 1,
    });

    const { rows } = await db.query(
      `-- tenant-scope-exempt: test assertion against the append-only case-export trail, keyed by case id
       select * from compliance_case_exports where case_id = $1`,
      ["case-1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.watermark).toBe("case-1/staff-opener/2026-09-18");

    const entries = await auditLog.listAll();
    expect(entries.some((e) => e.action === "compliance_case:record_export")).toBe(true);
  });

  it("findById round-trips a freshly opened case as unapproved (expiresAt null despite the NOT NULL storage column)", async () => {
    await openScopedCase();
    const found = await repo.findById(OPENER, "case-1");
    expect(found?.approvedBy).toBeNull();
    expect(found?.expiresAt).toBeNull();
  });
});
