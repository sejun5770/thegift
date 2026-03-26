/**
 * 개인정보 마스킹 유틸리티
 * GUIDELINE.md 2장 PII 규칙 준수
 */

/** 이름 마스킹: "홍길동" → "홍*동", "김철" → "김*" */
export function maskName(name: string | null | undefined): string {
  if (!name || name.trim().length === 0) return '';
  const trimmed = name.trim();
  if (trimmed.length === 1) return trimmed;
  if (trimmed.length === 2) return trimmed[0] + '*';
  return trimmed[0] + '*'.repeat(trimmed.length - 2) + trimmed[trimmed.length - 1];
}

/** 전화번호 마스킹: "010-1234-5678" → "010-****-5678" */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone || phone.trim().length === 0) return '';
  const trimmed = phone.trim().replace(/\s/g, '');

  // 하이픈이 있는 형식 (010-1234-5678)
  const dashMatch = trimmed.match(/^(\d{2,3})-(\d{3,4})-(\d{4})$/);
  if (dashMatch) {
    return `${dashMatch[1]}-${'*'.repeat(dashMatch[2].length)}-${dashMatch[3]}`;
  }

  // 하이픈 없는 형식 (01012345678)
  const plainMatch = trimmed.match(/^(\d{2,3})(\d{3,4})(\d{4})$/);
  if (plainMatch) {
    return `${plainMatch[1]}-${'*'.repeat(plainMatch[2].length)}-${plainMatch[3]}`;
  }

  // 기타 형식: 앞 3자리, 뒤 4자리만 표시
  if (trimmed.length >= 7) {
    const visible = 3;
    const tail = 4;
    return trimmed.substring(0, visible) + '*'.repeat(trimmed.length - visible - tail) + trimmed.substring(trimmed.length - tail);
  }

  return '*'.repeat(trimmed.length);
}

/** 주소 마스킹: 시/구 까지만 → "서울시 강남구 ***" */
export function maskAddress(address: string | null | undefined): string {
  if (!address || address.trim().length === 0) return '';
  const trimmed = address.trim();

  // "시/도 + 구/군/시" 패턴 매치
  const match = trimmed.match(
    /^(.*?(?:특별시|광역시|특별자치시|특별자치도|도|시|세종))\s*(.*?(?:시|군|구))/
  );
  if (match) {
    return `${match[1]} ${match[2]} ***`;
  }

  // 패턴 매치 실패 시 앞 부분만 표시
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return `${words[0]} ${words[1]} ***`;
  }

  return trimmed.substring(0, Math.min(6, trimmed.length)) + ' ***';
}
