import { NextRequest, NextResponse } from 'next/server';
import { MOCK_BG_STICKERS } from '@/lib/barungift/mock-data';

function isMockMode() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return !supabaseUrl || supabaseUrl.includes('your_supabase');
}

/** PUT /c/barungift/api/stickers/[stickerId] - 스티커 수정 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ stickerId: string }> }
) {
  const { stickerId } = await params;

  if (isMockMode()) {
    const body = await request.json();
    const existing = MOCK_BG_STICKERS.find((s) => s.id === stickerId);
    if (!existing) {
      return NextResponse.json({ error: '스티커를 찾을 수 없습니다.' }, { status: 404 });
    }
    return NextResponse.json({ ...existing, ...body, updated_at: new Date().toISOString() });
  }

  try {
    const { stickerUpdateSchema } = await import('@/lib/barungift/validations');
    const { updateSticker } = await import('@/lib/barungift/db');

    const body = await request.json();
    const parsed = stickerUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: '입력 데이터가 올바르지 않습니다.', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const sticker = await updateSticker(stickerId, parsed.data);
    return NextResponse.json(sticker);
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}

/** DELETE /c/barungift/api/stickers/[stickerId] - 스티커 소프트 삭제 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ stickerId: string }> }
) {
  const { stickerId } = await params;

  if (isMockMode()) {
    return NextResponse.json({ success: true });
  }

  try {
    const { deleteSticker } = await import('@/lib/barungift/db');
    await deleteSticker(stickerId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
