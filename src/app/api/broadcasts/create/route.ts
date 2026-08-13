import { after, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { drainBroadcastQueue } from '@/lib/whatsapp/broadcast-queue-processor';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    // 1. Authenticate session user
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Fetch user's profile and account_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Profile is not linked to an account' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { name, template, audience, variables, headerMediaUrl } = body;

    if (!template || !template.name) {
      return NextResponse.json(
        { error: 'Template is required' },
        { status: 400 },
      );
    }

    // 3. Resolve audience contacts
    let contacts: any[] = [];
    if (audience.type === 'all') {
      const { data } = await supabase.from('contacts').select('*');
      contacts = data ?? [];
    } else if (audience.type === 'tags' && Array.isArray(audience.tagIds) && audience.tagIds.length > 0) {
      const { data: contactTags } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (contactTags && contactTags.length > 0) {
        const uniqueIds = [...new Set(contactTags.map((ct) => ct.contact_id))];
        const { data } = await supabase
          .from('contacts')
          .select('*')
          .in('id', uniqueIds);
        contacts = data ?? [];
      }
    } else if (audience.type === 'csv' && Array.isArray(audience.csvContacts)) {
      // Look up contacts by phone for CSV audience
      const phones = audience.csvContacts.map((c: any) => c.phone).filter(Boolean);
      if (phones.length > 0) {
        const { data } = await supabase
          .from('contacts')
          .select('*')
          .in('phone', phones);
        contacts = data ?? [];
      }
    }

    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.excludeTagIds);
      const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    if (contacts.length === 0) {
      return NextResponse.json(
        { error: 'No recipients found for this audience' },
        { status: 400 },
      );
    }

    // 4. Insert broadcast row
    const { data: broadcast, error: bErr } = await supabase
      .from('broadcasts')
      .insert({
        user_id: user.id,
        account_id: accountId,
        name: name || `Broadcast (${template.name})`,
        template_name: template.name,
        template_language: template.language ?? 'en_US',
        template_variables: variables,
        audience_filter: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          excludeTagIds: audience.excludeTagIds,
          ...(headerMediaUrl ? { headerMediaUrl: headerMediaUrl.trim() } : {}),
        },
        status: 'sending',
        total_recipients: contacts.length,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
      })
      .select()
      .single();

    if (bErr || !broadcast) {
      console.error('[broadcast-create] Error inserting broadcast:', bErr);
      return NextResponse.json(
        { error: `Failed to create broadcast: ${bErr?.message ?? 'Unknown'}` },
        { status: 500 },
      );
    }

    // 5. Insert recipient rows with status 'pending'
    const recipientRows = contacts.map((contact) => ({
      broadcast_id: broadcast.id,
      contact_id: contact.id,
      status: 'pending' as const,
    }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < recipientRows.length; i += INSERT_CHUNK) {
      const batch = recipientRows.slice(i, i + INSERT_CHUNK);
      const { error: rErr } = await supabase
        .from('broadcast_recipients')
        .insert(batch);
      if (rErr) {
        await supabase
          .from('broadcasts')
          .update({ status: 'failed', failed_count: contacts.length })
          .eq('id', broadcast.id);
        return NextResponse.json(
          { error: `Failed to enqueue recipients: ${rErr.message}` },
          { status: 500 },
        );
      }
    }

    // 6. Schedule background server drain: 1 message per second
    after(() => {
      const admin = supabaseAdmin();
      drainBroadcastQueue(admin, broadcast.id, 1000).catch((err) =>
        console.error(`[broadcast-create] Error in background drain for ${broadcast.id}:`, err),
      );
    });

    return NextResponse.json({
      success: true,
      broadcastId: broadcast.id,
      total_recipients: contacts.length,
    });
  } catch (error) {
    console.error('[broadcast-create] Exception in POST:', error);
    return NextResponse.json(
      { error: 'Failed to process broadcast creation' },
      { status: 500 },
    );
  }
}
