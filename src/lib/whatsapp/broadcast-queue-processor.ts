import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import type { Contact, MessageTemplate } from '@/types';

export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (!v) return '';
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Process active broadcasts in status 'sending'.
 * For each sending broadcast, picks 1 pending recipient and attempts Meta API send.
 * Updates recipient status and finalizes broadcast status when finished.
 */
export async function processBroadcastQueue(
  db: SupabaseClient,
  batchSizePerBroadcast = 1,
): Promise<{
  processed: number;
  completed: number;
}> {
  let processedCount = 0;
  let completedCount = 0;

  // 1. Fetch all active broadcasts in status 'sending'
  const { data: sendingBroadcasts, error: bErr } = await db
    .from('broadcasts')
    .select('*')
    .eq('status', 'sending')
    .order('created_at', { ascending: true });

  if (bErr) {
    console.error('[broadcast-processor] Error fetching sending broadcasts:', bErr);
    return { processed: 0, completed: 0 };
  }

  if (!sendingBroadcasts || sendingBroadcasts.length === 0) {
    return { processed: 0, completed: 0 };
  }

  for (const broadcast of sendingBroadcasts) {
    // 2. Fetch pending recipient(s) for this broadcast
    const { data: recipients, error: rErr } = await db
      .from('broadcast_recipients')
      .select('*, contact:contacts(*)')
      .eq('broadcast_id', broadcast.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(batchSizePerBroadcast);

    if (rErr) {
      console.error(
        `[broadcast-processor] Error fetching recipients for broadcast ${broadcast.id}:`,
        rErr,
      );
      continue;
    }

    if (!recipients || recipients.length === 0) {
      // No pending recipients left for this broadcast -> check and finalize status
      await checkAndFinalizeIfDone(db, broadcast.id);
      completedCount++;
      continue;
    }

    for (const recipient of recipients) {
      // Safely resolve contact object (handling PostgREST object or array joins)
      let contact: Contact | null = null;
      if (recipient.contact) {
        contact = (
          Array.isArray(recipient.contact)
            ? recipient.contact[0]
            : recipient.contact
        ) as Contact | null;
      }

      if ((!contact || !contact.phone) && recipient.contact_id) {
        const { data: fetchedContact } = await db
          .from('contacts')
          .select('*')
          .eq('id', recipient.contact_id)
          .maybeSingle();
        contact = fetchedContact as Contact | null;
      }

      if (!contact || !contact.phone) {
        console.warn(
          `[broadcast-processor] Recipient ${recipient.id} missing contact or phone number`,
        );
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: 'No contact or phone number found',
          })
          .eq('id', recipient.id);

        processedCount++;
        await checkAndFinalizeIfDone(db, broadcast.id);
        continue;
      }

      // 3. Fetch WhatsApp config for account
      const { data: config, error: configErr } = await db
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', broadcast.account_id)
        .single();

      if (configErr || !config || !config.access_token) {
        console.error(
          `[broadcast-processor] Missing WhatsApp config for account ${broadcast.account_id}:`,
          configErr,
        );
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: 'WhatsApp integration not configured for account',
          })
          .eq('id', recipient.id);

        processedCount++;
        await checkAndFinalizeIfDone(db, broadcast.id);
        continue;
      }

      let accessToken: string;
      try {
        accessToken = decrypt(config.access_token);
      } catch (err) {
        console.error(
          `[broadcast-processor] Token decryption failed for account ${broadcast.account_id}:`,
          err,
        );
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: 'Failed to decrypt WhatsApp access token',
          })
          .eq('id', recipient.id);

        processedCount++;
        await checkAndFinalizeIfDone(db, broadcast.id);
        continue;
      }

      // 4. Fetch template row if template_name is specified
      let templateRow: MessageTemplate | null = null;
      if (broadcast.template_name) {
        let query = db
          .from('message_templates')
          .select('*')
          .eq('account_id', broadcast.account_id)
          .eq('name', broadcast.template_name);

        if (broadcast.template_language) {
          query = query.eq('language', broadcast.template_language);
        }

        const { data: rawTemplateRow } = await query.maybeSingle();

        if (rawTemplateRow && isMessageTemplate(rawTemplateRow)) {
          templateRow = rawTemplateRow as MessageTemplate;
        } else {
          // Fallback lookup without language filter if exact language match failed
          const { data: fallbackRow } = await db
            .from('message_templates')
            .select('*')
            .eq('account_id', broadcast.account_id)
            .eq('name', broadcast.template_name)
            .maybeSingle();

          if (fallbackRow && isMessageTemplate(fallbackRow)) {
            templateRow = fallbackRow as MessageTemplate;
          }
        }
      }

      // 5. Fetch custom values for contact if variables reference custom fields
      let customValuesMap: Map<string, string> | undefined;
      const variables = broadcast.template_variables as Record<
        string,
        VariableMapping
      > | null;

      if (variables) {
        const hasCustomFieldVar = Object.values(variables).some(
          (v) => v && v.type === 'custom_field',
        );

        if (hasCustomFieldVar) {
          const { data: cValues } = await db
            .from('contact_custom_values')
            .select('custom_field_id, value')
            .eq('contact_id', contact.id);

          customValuesMap = new Map<string, string>();
          for (const row of cValues ?? []) {
            customValuesMap.set(row.custom_field_id, row.value ?? '');
          }
        }
      }

      // 6. Resolve template variables
      const params = variables
        ? resolveVariables(variables, contact, customValuesMap)
        : [];

      // 7. Check for header media URL in audience_filter
      const audienceFilter = broadcast.audience_filter as {
        headerMediaUrl?: string;
      } | null;
      const headerMediaUrl = audienceFilter?.headerMediaUrl?.trim();
      const headerType = templateRow?.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      // 8. Sanitize phone & build variants
      const sanitized = sanitizePhoneForMeta(contact.phone);
      if (!isValidE164(sanitized)) {
        console.warn(
          `[broadcast-processor] Invalid E.164 phone number: ${contact.phone}`,
        );
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: 'Invalid E.164 phone number format',
          })
          .eq('id', recipient.id);

        processedCount++;
        await checkAndFinalizeIfDone(db, broadcast.id);
        continue;
      }

      const variants = phoneVariants(sanitized);
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: broadcast.template_name,
            language: broadcast.template_language || 'en_US',
            template: templateRow ?? undefined,
            messageParams,
            params,
          });
          sentMessageId = result.messageId;
          lastError = null;
          break;
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : 'Unknown error';
          lastError = errorMessage;
          if (!isRecipientNotAllowedError(errorMessage)) break;
        }
      }

      // 9. Stamp recipient row (PostgreSQL trigger automatically recomputes broadcasts aggregate counts)
      if (sentMessageId) {
        console.log(
          `[broadcast-processor] Sent broadcast message to ${contact.phone} (wamid: ${sentMessageId})`,
        );
        await db
          .from('broadcast_recipients')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: sentMessageId,
            error_message: null,
          })
          .eq('id', recipient.id);
      } else {
        console.error(
          `[broadcast-processor] Failed to send broadcast to ${contact.phone}:`,
          lastError,
        );
        await db
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: lastError || 'Failed to send message',
          })
          .eq('id', recipient.id);
      }

      processedCount++;

      // 10. Check if broadcast has completed
      await checkAndFinalizeIfDone(db, broadcast.id);
    }
  }

  return { processed: processedCount, completed: completedCount };
}

async function checkAndFinalizeIfDone(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  const { count: pendingCount } = await db
    .from('broadcast_recipients')
    .select('*', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');

  if (pendingCount === 0) {
    const { data: b } = await db
      .from('broadcasts')
      .select(
        'sent_count, delivered_count, read_count, replied_count, total_recipients',
      )
      .eq('id', broadcastId)
      .single();

    if (!b) return;

    const totalSuccess =
      (b.sent_count || 0) +
      (b.delivered_count || 0) +
      (b.read_count || 0) +
      (b.replied_count || 0);

    const finalStatus = totalSuccess > 0 ? 'sent' : 'failed';

    await db
      .from('broadcasts')
      .update({
        status: finalStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', broadcastId);
  }
}
