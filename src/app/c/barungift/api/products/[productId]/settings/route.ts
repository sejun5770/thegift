import { NextRequest, NextResponse } from 'next/server';
import { MOCK_BG_PRODUCT_SETTINGS } from '@/lib/barungift/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/** GET /c/barungift/api/products/[productId]/settings - 상품 설정 조회 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) {
  const { productId } = await params;

  if (isMockMode()) {
    const settings = MOCK_BG_PRODUCT_SETTINGS.find((s) => s.product_id === productId);
    return NextResponse.json({ settings: settings || null });
  }

  try {
    const { getProductSettings } = await import('@/lib/barungift/db');
    const settings = await getProductSettings(productId);
    return NextResponse.json({ settings });
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}

/** PUT /c/barungift/api/products/[productId]/settings - 상품 설정 수정 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) {
  const { productId } = await params;

  if (isMockMode()) {
    const body = await request.json();
    return NextResponse.json({
      id: `ps-${Date.now()}`,
      product_id: productId,
      ...body,
      updated_at: new Date().toISOString(),
    });
  }

  try {
    const { productSettingsUpdateSchema } = await import('@/lib/barungift/validations');
    const { upsertProductSettings } = await import('@/lib/barungift/db');

    const body = await request.json();
    const parsed = productSettingsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: '입력 데이터가 올바르지 않습니다.', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const settings = await upsertProductSettings(productId, parsed.data);
    return NextResponse.json(settings);
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
