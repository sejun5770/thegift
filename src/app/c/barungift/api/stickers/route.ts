import { NextRequest, NextResponse } from 'next/server';
import { MOCK_BG_STICKERS } from '@/lib/barungift/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/** GET /c/barungift/api/stickers - 스티커 목록 조회 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const activeOnly = searchParams.get('active_only') === 'true';

  if (isMockMode()) {
    const stickers = activeOnly
      ? MOCK_BG_STICKERS.filter((s) => s.is_active)
      : MOCK_BG_STICKERS;
    return NextResponse.json({ stickers });
  }

  try {
    const { getAllStickers } = await import('@/lib/barungift/db');
    const stickers = await getAllStickers(activeOnly);
    return NextResponse.json({ stickers });
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}

/** POST /c/barungift/api/stickers - 스티커 생성 */
export async function POST(request: NextRequest) {
  if (isMockMode()) {
    const body = await request.json();
    return NextResponse.json(
      {
        id: `sticker-${Date.now()}`,
        ...body,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { status: 201 }
    );
  }

  try {
    const { stickerCreateSchema } = await import('@/lib/barungift/validations');
    const { createSticker } = await import('@/lib/barungift/db');

    const body = await request.json();
    const parsed = stickerCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: '입력 데이터가 올바르지 않습니다.', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const sticker = await createSticker(parsed.data);
    return NextResponse.json(sticker, { status: 201 });
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
