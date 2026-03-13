import { NextRequest, NextResponse } from 'next/server';
import { MOCK_STICKER_TYPES } from '@/lib/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const activeOnly = searchParams.get('active_only') === 'true';

  if (isMockMode()) {
    let filtered = [...MOCK_STICKER_TYPES];
    if (activeOnly) {
      filtered = filtered.filter((s) => s.is_active);
    }
    return NextResponse.json(filtered);
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    let query = supabase.from('sticker_types').select('*').order('created_at', { ascending: false });

    if (activeOnly) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(MOCK_STICKER_TYPES);
    }

    return NextResponse.json(data || []);
  } catch {
    return NextResponse.json(MOCK_STICKER_TYPES);
  }
}

export async function POST(request: NextRequest) {
  if (isMockMode()) {
    const body = await request.json();
    return NextResponse.json({
      id: `st-${Date.now()}`,
      ...body,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { status: 201 });
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const body = await request.json();

    const { data, error } = await supabase
      .from('sticker_types')
      .insert({
        sticker_code: body.sticker_code,
        sticker_name: body.sticker_name,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
