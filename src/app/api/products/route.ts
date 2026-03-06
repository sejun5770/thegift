import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const search = searchParams.get('search') || '';
  const activeOnly = searchParams.get('active_only') === 'true';

  try {
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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data || []);
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
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
