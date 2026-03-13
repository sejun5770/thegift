import { NextRequest, NextResponse } from 'next/server';
import { MOCK_PRODUCTS } from '@/lib/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get('search') || '';
  const activeOnly = searchParams.get('active_only') === 'true';

  if (isMockMode()) {
    let filtered = [...MOCK_PRODUCTS];
    if (activeOnly) {
      filtered = filtered.filter((p) => p.is_active);
    }
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(
        (p) => p.product_name.toLowerCase().includes(s) || p.product_code.toLowerCase().includes(s)
      );
    }
    return NextResponse.json(filtered);
  }

  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();

    let query = supabase.from('products').select('*').order('created_at', { ascending: false });

    if (activeOnly) {
      query = query.eq('is_active', true);
    }
    if (search) {
      query = query.or(`product_name.ilike.%${search}%,product_code.ilike.%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(MOCK_PRODUCTS);
    }

    return NextResponse.json(data || []);
  } catch {
    return NextResponse.json(MOCK_PRODUCTS);
  }
}

export async function POST(request: NextRequest) {
  if (isMockMode()) {
    const body = await request.json();
    return NextResponse.json({
      id: `prod-${Date.now()}`,
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
      .from('products')
      .insert({
        product_code: body.product_code,
        product_name: body.product_name,
        price: body.price || 0,
        is_sticker_product: body.is_sticker_product || false,
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
