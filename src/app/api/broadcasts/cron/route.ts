import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { processBroadcastQueue } from '@/lib/whatsapp/broadcast-queue-processor';

async function verifyAuth(request: Request): Promise<boolean> {
  // 1. Check shared x-cron-secret header against AUTOMATION_CRON_SECRET if configured
  const expectedSecret = process.env.AUTOMATION_CRON_SECRET;
  if (expectedSecret) {
    const suppliedSecret = request.headers.get('x-cron-secret') ?? '';
    const suppliedBuf = Buffer.from(suppliedSecret);
    const expectedBuf = Buffer.from(expectedSecret);

    if (
      suppliedBuf.length === expectedBuf.length &&
      timingSafeEqual(suppliedBuf, expectedBuf)
    ) {
      return true;
    }
  }

  // 2. Fallback: check if caller has an active authenticated user session (dashboard / dev trigger)
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) return true;
  } catch {
    // Auth check failed
  }

  return false;
}

export async function GET(request: Request) {
  const isAuthorized = await verifyAuth(request);
  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = supabaseAdmin();
    const result = await processBroadcastQueue(admin);
    return NextResponse.json({
      success: true,
      processed: result.processed,
      completed: result.completed,
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
