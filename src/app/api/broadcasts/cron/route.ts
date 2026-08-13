import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { processSingleRecipient, checkAndFinalizeIfDone } from '@/lib/whatsapp/broadcast-queue-processor';

export const maxDuration = 60;

function matchesSecret(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  return (
    suppliedBuf.length === expectedBuf.length &&
    timingSafeEqual(suppliedBuf, expectedBuf)
  );
}

async function verifyAuth(request: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  const autoCronSecret = process.env.AUTOMATION_CRON_SECRET;

  const suppliedXCron = request.headers.get('x-cron-secret') ?? '';
  const authHeader = request.headers.get('authorization') ?? '';
  const suppliedBearer = authHeader.replace(/^Bearer\s+/i, '');

  if (cronSecret) {
    if (
      matchesSecret(suppliedXCron, cronSecret) ||
      matchesSecret(suppliedBearer, cronSecret)
    ) {
      return true;
    }
  }
  if (autoCronSecret) {
    if (
      matchesSecret(suppliedXCron, autoCronSecret) ||
      matchesSecret(suppliedBearer, autoCronSecret)
    ) {
      return true;
    }
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) return true;
  } catch {
    // Session check failed
  }

  // Allow POST from app or when no secret configured
  if (request.method === 'POST' || (!cronSecret && !autoCronSecret)) {
    return true;
  }

  return false;
}

/**
 * Cron handler: runs every 1 minute via Vercel Cron.
 * Sends exactly 1 pending message per active broadcast per invocation.
 * This gives us 1 message/minute pacing without needing long-running functions.
 */
export async function GET(request: Request) {
  const isAuthorized = await verifyAuth(request);
  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = supabaseAdmin();

    // Find all broadcasts that have pending recipients
    const { data: pendingRecipients } = await admin
      .from('broadcast_recipients')
      .select('broadcast_id')
      .eq('status', 'pending')
      .limit(200);

    if (!pendingRecipients || pendingRecipients.length === 0) {
      return NextResponse.json({ success: true, processed: 0, message: 'No pending recipients' });
    }

    const broadcastIds = [...new Set(pendingRecipients.map((r) => r.broadcast_id))];
    let processedCount = 0;

    for (const bId of broadcastIds) {
      // Fetch broadcast
      const { data: broadcast } = await admin
        .from('broadcasts')
        .select('*')
        .eq('id', bId)
        .single();

      if (!broadcast) continue;

      // Ensure broadcast is in 'sending' status
      if (broadcast.status !== 'sending') {
        await admin
          .from('broadcasts')
          .update({ status: 'sending', updated_at: new Date().toISOString() })
          .eq('id', bId);
      }

      // Process exactly 1 pending recipient for this broadcast
      try {
        const result = await processSingleRecipient(admin, broadcast);
        if (result.noMorePending) {
          await checkAndFinalizeIfDone(admin, bId);
        }
        processedCount++;
      } catch (err) {
        console.error(`[broadcast-cron] Error processing recipient for broadcast ${bId}:`, err);
      }

      // Check if broadcast is done
      await checkAndFinalizeIfDone(admin, bId);
    }

    return NextResponse.json({
      success: true,
      processed: processedCount,
      broadcasts: broadcastIds.length,
    });
  } catch (error) {
    console.error('[broadcast-cron] Error processing broadcast queue:', error);
    return NextResponse.json(
      { error: 'Failed to process broadcast queue' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
