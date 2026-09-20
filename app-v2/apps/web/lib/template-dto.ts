/**
 * Maps the persistence-layer `WhatsAppTemplateRecord`
 * (`@modules/whatsapp/application/ports`) onto the wire `Template` shape
 * (`@packages/contracts/src/templates`). Same discipline as
 * `contact-dto.ts`/`message-dto.ts`: parsed through the contract schema so a
 * field that drifts fails loudly instead of shipping quietly wrong.
 *
 * `metaTemplateId` and `components` are WhatsApp/Meta-only fields the record
 * adds on top of the vendor-neutral `Template` domain entity (see that
 * port's header comment) — `templateSchema` does not model them, and zod
 * strips them, same as `MessageRecord`'s extra columns in `message-dto.ts`.
 */
import { templateSchema, type Template } from "@packages/contracts/src/templates";
import type { WhatsAppTemplateRecord } from "@modules/whatsapp/application/ports";

export function toTemplateDTO(record: WhatsAppTemplateRecord): Template {
  return templateSchema.parse({
    id: record.id,
    accountId: record.accountId,
    name: record.name,
    language: record.language,
    category: record.category,
    status: record.status,
    bodyText: record.bodyText,
    variableCount: record.variableCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
