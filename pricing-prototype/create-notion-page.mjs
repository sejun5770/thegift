const NOTION_API_KEY = process.env.NOTION_API_KEY || process.argv[2];
const PARENT_PAGE_ID = "2183b02360d180a6bd1fe554f57398a4";

const headers = {
  "Authorization": `Bearer ${NOTION_API_KEY}`,
  "Content-Type": "application/json",
  "Notion-Version": "2022-06-28"
};

const products = [
  { name: "블렌딩 실링스티커 로즈 쿼츠(1set-18ea)", count: "1set(18개)", regular: 8000, setPrice: 3900, soloPrice: 5900, img: "https://file.barunsoncard.com/barunsoncard/seal_d_pk/800.png" },
  { name: "블렌딩 실링스티커 레몬 버터(1set-18ea)", count: "1set(18개)", regular: 8000, setPrice: 3900, soloPrice: 5900, img: "https://file.barunsoncard.com/barunsoncard/seal_d_yl/800.png" },
  { name: "실링스티커 스카이블루 리본 (1set-25ea)", count: "1set(25장)", regular: 35000, setPrice: 21000, soloPrice: 25000, img: "https://file.barunsoncard.com/barunsoncard/DD_seal_ribbon_b_b/500.png" },
  { name: "실링스티커 내츄럴크림 리본 (1set-25ea)", count: "1set(25장)", regular: 35000, setPrice: 21000, soloPrice: 25000, img: "https://file.barunsoncard.com/barunsoncard/DD_seal_ribbon_CR_b/500.png" },
];

function fmt(n) { return n.toLocaleString("ko-KR"); }
function pct(regular, sale) { return Math.round((1 - sale / regular) * 100); }

function text(content, opts = {}) {
  const t = { type: "text", text: { content } };
  if (opts.bold) t.annotations = { ...t.annotations, bold: true };
  if (opts.strikethrough) t.annotations = { ...t.annotations, strikethrough: true };
  if (opts.color) t.annotations = { ...t.annotations, color: opts.color };
  if (opts.code) t.annotations = { ...t.annotations, code: true };
  return t;
}

function heading1(content) {
  return { object: "block", type: "heading_1", heading_1: { rich_text: [text(content)] } };
}
function heading2(content) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [text(content)] } };
}
function heading3(content) {
  return { object: "block", type: "heading_3", heading_3: { rich_text: [text(content)] } };
}
function paragraph(...richTexts) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richTexts } };
}
function divider() {
  return { object: "block", type: "divider", divider: {} };
}
function callout(emoji, ...richTexts) {
  return { object: "block", type: "callout", callout: { rich_text: richTexts, icon: { type: "emoji", emoji }, color: "gray_background" } };
}
function bulletItem(...richTexts) {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richTexts } };
}
function tableRow(cells) {
  return { type: "table_row", table_row: { cells: cells.map(c => Array.isArray(c) ? c : [text(String(c))]) } };
}
function table(width, hasHeader, rows) {
  return {
    object: "block", type: "table",
    table: { table_width: width, has_column_header: hasHeader, has_row_header: false, children: rows }
  };
}
function toggle(title, children) {
  return {
    object: "block", type: "toggle",
    toggle: { rich_text: [text(title, { bold: true })], children }
  };
}
function quote(...richTexts) {
  return { object: "block", type: "quote", quote: { rich_text: richTexts } };
}
function image(url) {
  return { object: "block", type: "image", image: { type: "external", external: { url } } };
}

// Build price comparison table for products
function buildPriceTable() {
  const headerRow = tableRow([
    [text("상품명", { bold: true })],
    [text("수량", { bold: true })],
    [text("정가(소비자가)", { bold: true })],
    [text("세트가", { bold: true })],
    [text("세트할인율", { bold: true })],
    [text("단품가", { bold: true })],
    [text("단품할인율", { bold: true })]
  ]);
  const dataRows = products.map(p => tableRow([
    p.name,
    p.count,
    `${fmt(p.regular)}원`,
    `${fmt(p.setPrice)}원`,
    `-${pct(p.regular, p.setPrice)}%`,
    `${fmt(p.soloPrice)}원`,
    `-${pct(p.regular, p.soloPrice)}%`
  ]));
  return table(7, true, [headerRow, ...dataRows]);
}

// Style A description
function styleABlocks() {
  return [
    heading2("Style A: 탭 전환 방식"),
    callout("🔄",
      text("세트구매 / 단독구매 탭을 클릭하면 해당 구매 유형의 가격으로 전환됩니다.")
    ),
    paragraph(),
    heading3("구조"),
    bulletItem(text("상품 이미지")),
    bulletItem(text("상품명 + 수량")),
    bulletItem(text("[세트구매] [단독구매]", { code: true }), text(" 탭 UI (활성 탭 컬러 구분)")),
    bulletItem(text("정가", { strikethrough: true }), text(" (취소선)")),
    bulletItem(text("할인율 + 할인가", { bold: true }), text(" (빨강=세트, 파랑=단독)")),
    bulletItem(text("'청첩장과 함께 구매 시' 안내 문구 (세트탭 선택 시)")),
    paragraph(),
    heading3("장점"),
    bulletItem(text("카드 높이가 컴팩트 → 한 화면에 더 많은 상품 노출")),
    bulletItem(text("사용자가 관심 있는 구매 유형만 선택적으로 확인")),
    bulletItem(text("모바일에서도 공간 효율적")),
    paragraph(),
    heading3("단점"),
    bulletItem(text("탭을 전환해야만 다른 가격을 볼 수 있음 (비교가 즉시 안 됨)")),
    bulletItem(text("기본 탭이 어떤 것이냐에 따라 노출 편향 발생 가능")),
    paragraph(),
    heading3("적합한 경우"),
    bulletItem(text("상품 리스트가 많아 카드 높이를 최소화해야 할 때")),
    bulletItem(text("세트 구매 비율이 압도적으로 높아 기본값 세팅이 명확할 때")),
    divider()
  ];
}

// Style B description
function styleBBlocks() {
  return [
    heading2("Style B: 2단 비교 방식"),
    callout("⚖️",
      text("세트가와 단품가를 컬러 박스로 위아래 나란히 배치하여 한눈에 비교할 수 있습니다.")
    ),
    paragraph(),
    heading3("구조"),
    bulletItem(text("상품 이미지")),
    bulletItem(text("상품명 + 수량")),
    bulletItem(text("정가 ₩₩,₩₩₩원", { strikethrough: true })),
    bulletItem(text("🟥 세트구매 박스: ", { bold: true }), text("할인율 + 할인가 (빨강 배경)")),
    bulletItem(text("🟦 단독구매 박스: ", { bold: true }), text("할인율 + 할인가 (파랑 배경)")),
    paragraph(),
    heading3("장점"),
    bulletItem(text("두 가격을 동시에 비교 가능 → 세트 구매의 추가 혜택이 명확")),
    bulletItem(text("정가 대비 할인율이 모두 노출되어 가격 메리트 전달력 강함")),
    bulletItem(text("색상 구분으로 직관적 인지")),
    paragraph(),
    heading3("단점"),
    bulletItem(text("카드 높이가 길어짐 → 한 화면에 보이는 상품 수 감소")),
    bulletItem(text("모바일에서 정보량이 많아 보일 수 있음")),
    paragraph(),
    heading3("적합한 경우"),
    bulletItem(text("세트 할인 혜택을 적극적으로 어필하고 싶을 때")),
    bulletItem(text("상품 수가 적어 카드 높이가 커져도 괜찮을 때")),
    divider()
  ];
}

// Style C description
function styleCBlocks() {
  return [
    heading2("Style C: 뱃지 + 최저가 강조 방식"),
    callout("🏷️",
      text("이미지 위 빨간 뱃지로 세트 할인을 강조하고, 본문에는 단품가 기준 할인 정보를 표시합니다.")
    ),
    paragraph(),
    heading3("구조"),
    bulletItem(text("상품 이미지 + "), text("🔴 '세트구매 시 -XX%' 뱃지", { bold: true }), text(" (이미지 좌상단)")),
    bulletItem(text("상품명 + 수량")),
    bulletItem(text("정가", { strikethrough: true }), text(" (취소선)")),
    bulletItem(text("단품 할인율 + 단품가", { bold: true }), text(" (메인 가격)")),
    paragraph(),
    heading3("장점"),
    bulletItem(text("쿠팡, 네이버 쇼핑 등 익숙한 커머스 패턴 → 학습 비용 최소")),
    bulletItem(text("뱃지가 시선을 끌어 세트 혜택을 자연스럽게 인지")),
    bulletItem(text("카드 본문은 심플하게 유지")),
    paragraph(),
    heading3("단점"),
    bulletItem(text("세트가의 구체적인 금액은 카드에서 바로 확인 불가")),
    bulletItem(text("뱃지가 이미지를 가릴 수 있음")),
    paragraph(),
    heading3("적합한 경우"),
    bulletItem(text("기존 커머스 사이트와 일관된 UX를 유지하고 싶을 때")),
    bulletItem(text("단독구매가 주 시나리오이지만 세트 혜택도 알리고 싶을 때")),
    divider()
  ];
}

// Comparison table
function comparisonTable() {
  return table(4, true, [
    tableRow([
      [text("항목", { bold: true })],
      [text("A. 탭 전환", { bold: true })],
      [text("B. 2단 비교", { bold: true })],
      [text("C. 뱃지 강조", { bold: true })]
    ]),
    tableRow(["정보 밀도", "⭐⭐⭐ 높음", "⭐⭐ 보통", "⭐⭐⭐ 높음"]),
    tableRow(["가격 비교 용이성", "⭐ 낮음 (전환 필요)", "⭐⭐⭐ 높음", "⭐⭐ 보통"]),
    tableRow(["카드 높이", "컴팩트", "높음", "컴팩트"]),
    tableRow(["모바일 적합성", "⭐⭐⭐ 우수", "⭐⭐ 보통", "⭐⭐⭐ 우수"]),
    tableRow(["세트 혜택 전달력", "⭐⭐ 보통", "⭐⭐⭐ 강함", "⭐⭐⭐ 강함"]),
    tableRow(["사용자 익숙도", "⭐⭐ 보통", "⭐⭐ 보통", "⭐⭐⭐ 높음 (쿠팡 등)"]),
  ]);
}

async function createPage() {
  const body = {
    parent: { page_id: PARENT_PAGE_ID },
    icon: { type: "emoji", emoji: "💰" },
    cover: { type: "external", external: { url: "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1200" } },
    properties: {
      title: [{ type: "text", text: { content: "상품 가격 표현 UI 제안서 — 세트가 / 단품가 할인 표시" } }]
    },
    children: [
      // Header section
      callout("📋",
        text("작성일: 2026-03-13  |  "),
        text("상태: 검토 중", { bold: true, color: "orange" }),
        text("  |  대상: 추가상품(실링스티커 등) 상품 리스트 카드")
      ),
      paragraph(),

      // Background
      heading1("1. 배경 및 목적"),
      paragraph(
        text("현재 상품 리스트의 가격 표시는 "),
        text("단품가만 노출", { bold: true }),
        text("되고 있어, 고객이 다음을 인지하기 어렵습니다:")
      ),
      bulletItem(text("정가(소비자가) 대비 얼마나 할인된 가격인지")),
      bulletItem(text("청첩장과 함께 구매(세트구매) 시 추가 할인 혜택이 있는지")),
      paragraph(),
      quote(
        text("목표: ", { bold: true }),
        text("정가 대비 세트가/단품가 할인율을 효과적으로 표현하여, 할인 메리트와 세트구매 유도를 동시에 달성")
      ),
      divider(),

      // Price structure
      heading1("2. 현재 가격 체계"),
      buildPriceTable(),
      paragraph(),
      callout("💡",
        text("세트가", { bold: true, color: "red" }),
        text(" = 청첩장과 함께 구매 시 적용 (더 낮음)  |  "),
        text("단품가", { bold: true, color: "blue" }),
        text(" = 단독 구매 시 적용 (현재 노출 가격)")
      ),
      divider(),

      // 3 Styles
      heading1("3. UI 스타일 제안 (3종)"),
      paragraph(
        text("각 스타일별 PC/Mobile 프로토타입은 별도 링크에서 확인 가능합니다.")
      ),
      paragraph(),

      ...styleABlocks(),
      ...styleBBlocks(),
      ...styleCBlocks(),

      // Comparison
      heading1("4. 스타일 비교표"),
      comparisonTable(),
      divider(),

      // Recommendation
      heading1("5. 권장안"),
      callout("✅",
        text("권장: Style C (뱃지 + 최저가 강조)", { bold: true }),
        text("\n\n사유:\n"),
        text("• 쿠팡/네이버 등 고객이 익숙한 커머스 패턴\n"),
        text("• 카드 높이가 컴팩트하여 모바일 대응 우수\n"),
        text("• 이미지 뱃지로 세트 혜택을 자연스럽게 노출\n"),
        text("• 단품가 기준 정가 대비 할인 표시로 가격 메리트 명확")
      ),
      paragraph(),
      paragraph(
        text("단, 세트 구매 전환율을 극대화하려면 "),
        text("Style B", { bold: true }),
        text("도 A/B 테스트 후보로 고려할 만합니다.")
      ),
      divider(),

      // Next steps
      heading1("6. 다음 단계"),
      bulletItem(text("[ ] 스타일 최종 선택")),
      bulletItem(text("[ ] 상품별 정가(소비자가) 데이터 확보 및 DB 컬럼 추가")),
      bulletItem(text("[ ] 프론트엔드 구현 (PC + Mobile 반응형)")),
      bulletItem(text("[ ] QA 및 크로스브라우저 테스트")),
      bulletItem(text("[ ] A/B 테스트 계획 수립 (선택)")),
    ]
  };

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("Error:", JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log("Page created successfully!");
  console.log("URL:", data.url);
  console.log("ID:", data.id);
}

createPage();
