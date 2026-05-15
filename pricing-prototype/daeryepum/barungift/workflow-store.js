/**
 * 정보입력현황 워크플로우 + 스티커 이미지 + 송장 — Supabase store.
 *
 * 데이터 모델:
 *   - 워크플로우 timestamps 는 bg_order_customer_info.sticker_selections[i] JSONB 인라인.
 *     sticker_completed_at, printed_at, bound_at, packed_at, shipped_at (+ *_by)
 *     images: [{ filename, uploaded_at, uploaded_by, is_main, mime, path, size }]
 *   - 송장은 bg_order_invoices 별도 테이블 (1주문 N송장 분리배송 지원).
 *
 * Storage:
 *   bucket 'bg-order-stickers' (private).
 *   path: '{order_id}/{sticker_index}/{filename}'
 */
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY; // storage upload 는 service key 권장
const USE = !!(SUPABASE_URL && SUPABASE_KEY);
const REST = `${SUPABASE_URL}/rest/v1`;
const STORAGE = `${SUPABASE_URL}/storage/v1`;
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
const HDR_SERVICE = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

const BUCKET = 'bg-order-stickers';

// ============================================
// orderId 별 in-memory mutex — JSONB read-modify-write race 방지.
//   2명 동시 작업 시 직렬화. 단일 노드 가정 (Docker 컨테이너 1 instance).
//   다중 노드면 Supabase advisory lock 필요 (Phase 2).
// ============================================
const _orderLocks = new Map();

async function withOrderLock(orderId, fn) {
  const prev = _orderLocks.get(orderId) || Promise.resolve();
  let resolveCur;
  const cur = new Promise(r => { resolveCur = r; });
  _orderLocks.set(orderId, prev.then(() => cur));
  try { await prev; } catch {}
  try {
    return await fn();
  } finally {
    resolveCur();
    // 마지막 holder 면 cleanup (메모리 누수 방지)
    if (_orderLocks.get(orderId) === cur || _orderLocks.get(orderId) === prev.then(() => cur)) {
      _orderLocks.delete(orderId);
    }
  }
}

// ============================================
// 워크플로우 stage helpers
// ============================================

/** 가능한 stage 키 (순서대로). */
const STAGE_KEYS = ['sticker_completed', 'printed', 'bound', 'packed'];
// 'shipped' 는 bg_order_invoices 에 row 생기는 시점 = 별도

/** stage → JSONB 안의 *_at, *_by 필드명. */
function stageTimestampKey(stage) { return `${stage}_at`; }
function stageByKey(stage) { return `${stage}_by`; }

/**
 * customer_info row 조회 — 워크플로우 patch 의 read-modify-write 용.
 */
async function getCustomerInfoForUpdate(orderId) {
  if (!USE) return null;
  const url = `${REST}/bg_order_customer_info?order_id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`;
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

/** PATCH 통해 customer_info row 업데이트 (sticker_selections 등). */
async function updateCustomerInfo(orderId, patch) {
  if (!USE) throw new Error('Supabase 미설정');
  const res = await fetch(`${REST}/bg_order_customer_info?order_id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HDR, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase patch bg_order_customer_info [${res.status}]: ${t.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/**
 * 스티커 selection 워크플로우 진행 / 점프.
 *   - 단일 stage 진행: stage='printed' → 해당 timestamp 만 set (이전 stages 도 아직 안 set 이면 누락)
 *   - 점프 모드 (jump=true): target stage 까지 timestamp set, 이후 stages 는 모두 NULL 처리 (롤백)
 *   - target 이 null 이면 모든 stage 초기화 (초기 입력완료 상태로)
 */
async function patchStickerWorkflow(opts) {
  return withOrderLock(opts.orderId, () => _patchStickerWorkflowImpl(opts));
}
async function _patchStickerWorkflowImpl({ orderId, stickerIndex, stage, by, jump = false, clearFuture = true }) {
  const ci = await getCustomerInfoForUpdate(orderId);
  if (!ci) throw new Error(`customer_info not found: ${orderId}`);
  const sels = Array.isArray(ci.sticker_selections) ? [...ci.sticker_selections] : [];
  if (stickerIndex < 0 || stickerIndex >= sels.length) throw new Error(`sticker_index 범위 초과: ${stickerIndex}/${sels.length}`);
  const sel = { ...sels[stickerIndex] };
  const now = new Date().toISOString();

  if (jump || stage === null) {
    // 점프 — target 까지 set, 이후 NULL
    const targetIdx = stage === null ? -1 : STAGE_KEYS.indexOf(stage);
    if (stage !== null && targetIdx < 0) throw new Error(`unknown stage: ${stage}`);
    STAGE_KEYS.forEach((s, i) => {
      const tsKey = stageTimestampKey(s);
      const byKey = stageByKey(s);
      if (i <= targetIdx) {
        // 이 단계까지는 만족해야 함 — 기존 값 유지, 없으면 now 로 채움
        if (!sel[tsKey]) {
          sel[tsKey] = now;
          sel[byKey] = by || null;
        }
      } else if (clearFuture) {
        sel[tsKey] = null;
        sel[byKey] = null;
      }
    });
  } else {
    // 단일 stage 진행
    const idx = STAGE_KEYS.indexOf(stage);
    if (idx < 0) throw new Error(`unknown stage: ${stage}`);
    sel[stageTimestampKey(stage)] = now;
    sel[stageByKey(stage)] = by || null;
  }

  sels[stickerIndex] = sel;
  return updateCustomerInfo(orderId, { sticker_selections: sels });
}

/**
 * 스티커 이미지 metadata 추가 (sticker_selections[idx].images 배열 push).
 *   업로드 후 호출. 첫 이미지면 is_main=true, sticker_completed_at 자동 set.
 *   options.alreadyMain=true 이면 다른 이미지 is_main 모두 false 처리.
 */
async function addStickerImageMeta(opts) {
  return withOrderLock(opts.orderId, () => _addStickerImageMetaImpl(opts));
}
async function _addStickerImageMetaImpl({ orderId, stickerIndex, image, by }) {
  const ci = await getCustomerInfoForUpdate(orderId);
  if (!ci) throw new Error(`customer_info not found: ${orderId}`);
  const sels = Array.isArray(ci.sticker_selections) ? [...ci.sticker_selections] : [];
  if (stickerIndex < 0 || stickerIndex >= sels.length) throw new Error(`sticker_index 범위 초과`);
  const sel = { ...sels[stickerIndex] };
  const images = Array.isArray(sel.images) ? [...sel.images] : [];
  // 첫 이미지면 자동 메인 + sticker_completed_at 자동 set
  const isFirst = !images.length;
  if (isFirst) {
    sel.sticker_completed_at = sel.sticker_completed_at || new Date().toISOString();
    sel.sticker_completed_by = sel.sticker_completed_by || by || null;
  }
  images.push({
    filename: image.filename,
    path: image.path,
    mime: image.mime || null,
    size: image.size || null,
    uploaded_at: new Date().toISOString(),
    uploaded_by: by || null,
    is_main: isFirst, // 첫 이미지 자동 메인
  });
  sel.images = images;
  sels[stickerIndex] = sel;
  return updateCustomerInfo(orderId, { sticker_selections: sels });
}

/** 스티커 이미지 metadata 제거. 마지막 이미지 삭제 시 sticker_completed_at 도 NULL 처리. */
async function removeStickerImageMeta(opts) {
  return withOrderLock(opts.orderId, () => _removeStickerImageMetaImpl(opts));
}
async function _removeStickerImageMetaImpl({ orderId, stickerIndex, filename }) {
  const ci = await getCustomerInfoForUpdate(orderId);
  if (!ci) throw new Error(`customer_info not found: ${orderId}`);
  const sels = Array.isArray(ci.sticker_selections) ? [...ci.sticker_selections] : [];
  if (stickerIndex < 0 || stickerIndex >= sels.length) throw new Error(`sticker_index 범위 초과`);
  const sel = { ...sels[stickerIndex] };
  const images = (sel.images || []).filter(img => img.filename !== filename);
  // 메인이 삭제됐으면 남은 첫 이미지에 메인 부여
  const hadMain = (sel.images || []).find(img => img.filename === filename && img.is_main);
  if (hadMain && images.length) images[0].is_main = true;
  // 모두 삭제됐으면 sticker_completed_at 초기화 (그리고 이후 stages 도 모두 초기화)
  if (!images.length) {
    sel.sticker_completed_at = null; sel.sticker_completed_by = null;
    sel.printed_at = null; sel.printed_by = null;
    sel.bound_at = null; sel.bound_by = null;
    sel.packed_at = null; sel.packed_by = null;
  }
  sel.images = images;
  sels[stickerIndex] = sel;
  return updateCustomerInfo(orderId, { sticker_selections: sels });
}

/** 메인 이미지 변경. */
async function setStickerMainImage(opts) {
  return withOrderLock(opts.orderId, () => _setStickerMainImageImpl(opts));
}
async function _setStickerMainImageImpl({ orderId, stickerIndex, filename }) {
  const ci = await getCustomerInfoForUpdate(orderId);
  if (!ci) throw new Error(`customer_info not found: ${orderId}`);
  const sels = Array.isArray(ci.sticker_selections) ? [...ci.sticker_selections] : [];
  if (stickerIndex < 0 || stickerIndex >= sels.length) throw new Error(`sticker_index 범위 초과`);
  const sel = { ...sels[stickerIndex] };
  let found = false;
  sel.images = (sel.images || []).map(img => {
    const isMatch = img.filename === filename;
    if (isMatch) found = true;
    return { ...img, is_main: isMatch };
  });
  if (!found) throw new Error(`image not found: ${filename}`);
  sels[stickerIndex] = sel;
  return updateCustomerInfo(orderId, { sticker_selections: sels });
}

// ============================================
// Storage — Supabase Storage REST API
// ============================================

/** Upload file (Buffer) to storage. Returns the stored path. */
async function uploadStickerImage({ orderId, stickerIndex, filename, buffer, mime }) {
  if (!USE) throw new Error('Supabase 미설정');
  // path: {order_id}/{sticker_index}/{ts}_{filename} — 충돌 방지 timestamp prefix
  const ts = Date.now();
  const safeName = String(filename).replace(/[^\w.\-가-힣]+/g, '_').slice(0, 100);
  const path = `${orderId}/${stickerIndex}/${ts}_${safeName}`;
  const url = `${STORAGE}/object/${BUCKET}/${encodeURI(path)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...HDR_SERVICE,
      'Content-Type': mime || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Storage upload [${res.status}]: ${t.slice(0, 300)}`);
  }
  return { path, filename: safeName, ts };
}

/** Generate signed URL for download (1 hour expiry). */
async function getStickerImageSignedUrl(path, expiresSec = 3600) {
  if (!USE) throw new Error('Supabase 미설정');
  const url = `${STORAGE}/object/sign/${BUCKET}/${encodeURI(path)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HDR_SERVICE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: expiresSec }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Storage sign [${res.status}]: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return `${STORAGE}${data.signedURL || data.signedUrl}`;
}

/** Delete file from storage. */
async function deleteStickerImage(path) {
  if (!USE) throw new Error('Supabase 미설정');
  const url = `${STORAGE}/object/${BUCKET}/${encodeURI(path)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: HDR_SERVICE,
  });
  if (!res.ok && res.status !== 404) {
    const t = await res.text();
    throw new Error(`Storage delete [${res.status}]: ${t.slice(0, 300)}`);
  }
}

// ============================================
// 송장 (bg_order_invoices)
// ============================================

async function listInvoices(orderId) {
  if (!USE) return [];
  const url = `${REST}/bg_order_invoices?order_id=eq.${encodeURIComponent(orderId)}&select=*&order=shipped_at.desc`;
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) return [];
  return res.json();
}

async function insertInvoice(opts) {
  return withOrderLock(opts.orderId, () => _insertInvoiceImpl(opts));
}
async function _insertInvoiceImpl({ orderId, invoiceNumber, deliveryCompany, stickerIndices = [], shippedBy, notes }) {
  if (!USE) throw new Error('Supabase 미설정');
  if (!invoiceNumber) throw new Error('invoice_number 필수');
  if (!deliveryCompany) throw new Error('delivery_company 필수');
  // sticker_indices 검증 — sticker_selections 범위 내인지, 유효 정수인지
  const ci = await getCustomerInfoForUpdate(orderId);
  if (!ci) throw new Error(`customer_info not found: ${orderId}`);
  const selsLen = Array.isArray(ci.sticker_selections) ? ci.sticker_selections.length : 0;
  const validIndices = (stickerIndices || []).filter(i => Number.isInteger(i) && i >= 0 && i < selsLen);
  if (!validIndices.length) {
    throw new Error(`유효한 sticker_indices 없음 (sticker_selections 길이: ${selsLen})`);
  }
  const body = {
    order_id: orderId,
    invoice_number: invoiceNumber,
    delivery_company: deliveryCompany,
    sticker_indices: validIndices,
    shipped_by: shippedBy || null,
    notes: notes || null,
  };
  const res = await fetch(`${REST}/bg_order_invoices`, {
    method: 'POST',
    headers: { ...HDR, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase insert bg_order_invoices [${res.status}]: ${t.slice(0, 300)}`);
  }
  const rows = await res.json();
  const inv = rows[0];

  // 워크플로우 timestamps 도 동기화 — validIndices 의 shipped_at set
  try {
    const ciFresh = await getCustomerInfoForUpdate(orderId);
    if (ciFresh) {
      const sels = Array.isArray(ciFresh.sticker_selections) ? [...ciFresh.sticker_selections] : [];
      const now = new Date().toISOString();
      validIndices.forEach(i => {
        if (sels[i]) {
          sels[i] = { ...sels[i], shipped_at: now, shipped_by: shippedBy || null };
        }
      });
      await updateCustomerInfo(orderId, { sticker_selections: sels });
    }
  } catch (e) {
    console.warn(`[invoice insert] sticker shipped_at sync 실패 ${orderId}: ${e.message}`);
  }
  return inv;
}

async function deleteInvoice(invoiceId) {
  if (!USE) throw new Error('Supabase 미설정');
  // 1) row 먼저 조회 (rollback 용 정보)
  const sel = await fetch(`${REST}/bg_order_invoices?id=eq.${encodeURIComponent(invoiceId)}&select=*&limit=1`, { headers: HDR });
  const _earlyRows = sel.ok ? await sel.clone().json() : [];
  const orderIdForLock = _earlyRows[0]?.order_id;
  if (orderIdForLock) {
    return withOrderLock(orderIdForLock, () => _deleteInvoiceImpl(invoiceId, _earlyRows));
  }
  return _deleteInvoiceImpl(invoiceId, _earlyRows);
}
async function _deleteInvoiceImpl(invoiceId, prefetchedRows) {
  // 1) row 정보 (외부에서 prefetch 한 데이터 재활용)
  const inv = (prefetchedRows && prefetchedRows[0]) || null;
  // 2) 삭제
  const res = await fetch(`${REST}/bg_order_invoices?id=eq.${encodeURIComponent(invoiceId)}`, {
    method: 'DELETE',
    headers: HDR,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase delete bg_order_invoices [${res.status}]: ${t.slice(0, 300)}`);
  }
  // 3) sticker shipped_at 도 다른 invoice 없으면 NULL 처리
  if (inv && Array.isArray(inv.sticker_indices) && inv.sticker_indices.length) {
    const remaining = await listInvoices(inv.order_id);
    const stillShipped = new Set(remaining.flatMap(r => r.sticker_indices || []));
    try {
      const ci = await getCustomerInfoForUpdate(inv.order_id);
      if (ci) {
        const sels = Array.isArray(ci.sticker_selections) ? [...ci.sticker_selections] : [];
        let changed = false;
        inv.sticker_indices.forEach(i => {
          if (sels[i] && !stillShipped.has(i)) {
            sels[i] = { ...sels[i], shipped_at: null, shipped_by: null };
            changed = true;
          }
        });
        if (changed) await updateCustomerInfo(inv.order_id, { sticker_selections: sels });
      }
    } catch (e) {
      console.warn(`[invoice delete] sticker shipped_at rollback 실패: ${e.message}`);
    }
  }
  return { ok: true, invoice: inv };
}

module.exports = {
  USE,
  BUCKET,
  STAGE_KEYS,
  getCustomerInfoForUpdate,
  updateCustomerInfo,
  patchStickerWorkflow,
  addStickerImageMeta,
  removeStickerImageMeta,
  setStickerMainImage,
  uploadStickerImage,
  getStickerImageSignedUrl,
  deleteStickerImage,
  listInvoices,
  insertInvoice,
  deleteInvoice,
};
