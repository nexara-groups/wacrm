import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { processBroadcastQueue } from '@/lib/whatsapp/broadcast-queue-processor';

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

  // 1. Check x-cron-secret or Authorization header against CRON_SECRET / AUTOMATION_CRON_SECRET
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

  // 2. Check active user session (dashboard trigger)
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) return true;
  } catch {
    // Session check failed
  }

  // 3. Dev environment fallback when no secret is configured
  if (!cronSecret && !autoCronSecret) {
    return true;
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
