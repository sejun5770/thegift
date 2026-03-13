import { NextRequest, NextResponse } from 'next/server';
import { MOCK_BOX_TYPES } from '@/lib/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const activeOnly = searchParams.get('active_only') === 'true';

  if (isMockMode()) {
    let filtered = [...MOCK_BOX_TYPES];
    if (activeOnly) {
      filtered = filtered.filter((b) => b.is_active);
    }
    return NextResponse.json(filtered);
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    let query = supabase.from('box_types').select('*').order('created_at', { ascending: false });

    if (activeOnly) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(MOCK_BOX_TYPES);
    }

    return NextResponse.json(data || []);
  } catch {
    return NextResponse.json(MOCK_BOX_TYPES);
  }
}

export async function POST(request: NextRequest) {
  if (isMockMode()) {
    const body = await request.json();
    return NextResponse.json({
      id: `box-${Date.now()}`,
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
      .from('box_types')
      .insert({
        box_code: body.box_code,
        box_name: body.box_name,
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
