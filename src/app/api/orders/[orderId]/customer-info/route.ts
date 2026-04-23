import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export interface CustomerInfoDetail {
  id: string;
  order_id: string;          // order_number
  is_express: boolean;
  express_fee: number;
  desired_ship_date: string | null;
  sticker_selections_detail: Array<{
    sticker_id: string;
    sticker_name: string;
    custom_values_formatted: Array<{ label: string; value: string }>;
  }>;
  cash_receipt_yn: boolean;
  receipt_type: 'personal' | 'business' | null;
  receipt_number: string | null;
  submitted_at: string;
}

/** GET /api/orders/[orderId]/customer-info
 *  orderId = orders.id (UUID) — 관리자 화면에서 사용
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  try {
    const supabase = await createClient();

    // orders UUID → order_number 조회
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('order_number')
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ error: '주문을 찾을 수 없습니다.' }, { status: 404 });
    }

    // bg_order_customer_info 조회 (order_id = order_number)
    const { data: info, error: infoErr } = await supabase
      .from('bg_order_customer_info')
      .select('*')
      .eq('order_id', order.order_number)
      .single();

    if (infoErr || !info) {
      return NextResponse.json(null, { status: 200 }); // 고객 미입력 상태
    }

    // 스티커 ID 목록 추출
    const selections: Array<{ product_id: string; sticker_id: string; custom_values: Record<string, string> }> =
      info.sticker_selections ?? [];

    const stickerIds = [...new Set(selections.map((s) => s.sticker_id).filter(Boolean))];

    // bg_stickers 조회 (이름 + custom_fields)
    let stickerMap: Record<string, { name: string; custom_fields: Array<{ field_id: string; field_label: string }> }> = {};
    if (stickerIds.length > 0) {
      const { data: stickers } = await supabase
        .from('bg_stickers')
        .select('id, name, custom_fields')
        .in('id', stickerIds);

      for (const s of stickers ?? []) {
        stickerMap[s.id] = { name: s.name, custom_fields: s.custom_fields ?? [] };
      }
    }

    // sticker_selections 보강
    const sticker_selections_detail = selections.map((sel) => {
      const meta = stickerMap[sel.sticker_id];
      const custom_values_formatted = (meta?.custom_fields ?? [])
        .filter((f) => sel.custom_values?.[f.field_id])
        .map((f) => ({ label: f.field_label, value: sel.custom_values[f.field_id] }));

      return {
        sticker_id: sel.sticker_id,
        sticker_name: meta?.name ?? '알 수 없는 스티커',
        custom_values_formatted,
      };
    });

    const result: CustomerInfoDetail = {
      id: info.id,
      order_id: info.order_id,
      is_express: info.is_express,
      express_fee: info.express_fee,
      desired_ship_date: info.desired_ship_date,
      sticker_selections_detail,
      cash_receipt_yn: info.cash_receipt_yn,
      receipt_type: info.receipt_type,
      receipt_number: info.receipt_number,
      submitted_at: info.submitted_at,
    };

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '서버 오류';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
