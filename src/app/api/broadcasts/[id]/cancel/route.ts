import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { cancelBroadcastPendingQueue } from '@/lib/whatsapp/broadcast-queue-processor';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient();
    const { id } = await params;

    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await cancelBroadcastPendingQueue(supabase, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[broadcast-cancel] Error cancelling pending queue:', error);
    return NextResponse.json(
      { error: 'Failed to cancel broadcast queue' },
      { status: 500 },
    );
  }
}
