'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Eye, Loader2, MessageSquare, RefreshCw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateKo, formatDateTimeKo } from '@/lib/date-utils';

interface Recipient {
  order_id: string;
  order_number: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  status: string | null;
  desired_shipping_date: string | null;
  collected_at: string | null;
  product_name: string | null;
  product_code: string | null;
  last_alimtalk_sent_at: string | null;
  alimtalk_send_count: number;
}

interface SendResult {
  order_id: string;
  success: boolean;
  mock?: boolean;
  message_id?: string;
  skipped_reason?: 'not_daeryepum' | 'missing_phone' | 'order_not_found';
  error?: string;
}

interface SendSummary {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
}

interface PreviewData {
  text: string;
  templateCode: string;
  customerUrl: string;
  button: { name: string; type: string; url_mobile: string; url_pc: string } | null;
  variables: Record<string, string>;
  recipient_phone?: string;
  sample: boolean;
}

type SentStatus = 'all' | 'sent' | 'unsent';

const PAGE_LIMIT = 50;

export default function AlimtalkBulkPage() {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [sentStatus, setSentStatus] = useState<SentStatus>('unsent');
  const [search, setSearch] = useState('');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPreview, setConfirmPreview] = useState<PreviewData | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [resultsOpen, setResultsOpen] = useState(false);
  const [sendResultsData, setSendResultsData] = useState<{
    results: SendResult[];
    summary: SendSummary;
    mock: boolean;
  } | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  const fetchRecipients = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_LIMIT),
        sent_status: sentStatus,
      });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (search) params.set('search', search);

      const res = await fetch(`/c/barungift/api/alimtalk/recipients?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRecipients(data.recipients ?? []);
      setTotal(data.total ?? 0);
      setSelectedIds([]);
    } catch (e) {
      toast.error(
        e instanceof Error ? `목록 조회 실패: ${e.message}` : '목록 조회 실패'
      );
      setRecipients([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, sentStatus, startDate, endDate, search]);

  useEffect(() => {
    fetchRecipients();
  }, [fetchRecipients]);

  const sendableIds = useMemo(
    () => recipients.filter((r) => r.recipient_phone).map((r) => r.order_id),
    [recipients]
  );

  const recipientMap = useMemo(
    () => new Map(recipients.map((r) => [r.order_id, r])),
    [recipients]
  );

  const allSendableSelected =
    sendableIds.length > 0 &&
    sendableIds.every((id) => selectedIds.includes(id));

  const toggleAll = () => {
    if (allSendableSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(sendableIds);
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const fetchPreview = async (orderId?: string) => {
    setPreviewLoading(true);
    try {
      const url = orderId
        ? `/c/barungift/api/alimtalk/preview?order_id=${orderId}`
        : '/c/barungift/api/alimtalk/preview';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as PreviewData;
    } catch (e) {
      toast.error('미리보기 로드 실패');
      throw e;
    } finally {
      setPreviewLoading(false);
    }
  };

  const openPreview = async (orderId?: string) => {
    try {
      const data = await fetchPreview(orderId);
      setPreviewData(data);
      setPreviewOpen(true);
    } catch {
      // toast already shown
    }
  };

  const openConfirm = async () => {
    if (selectedIds.length === 0) return;
    try {
      const firstId = selectedIds[0];
      const data = await fetchPreview(firstId);
      setConfirmPreview(data);
    } catch {
      setConfirmPreview(null);
    }
    setConfirmOpen(true);
  };

  const handleSend = async () => {
    if (selectedIds.length === 0) return;
    setSending(true);
    try {
      const res = await fetch('/c/barungift/api/alimtalk/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_ids: selectedIds }),
      });
      const data = (await res.json()) as {
        results?: SendResult[];
        summary?: SendSummary;
        mock?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const summary = data.summary ?? { total: 0, sent: 0, failed: 0, skipped: 0 };
      setSendResultsData({
        results: data.results ?? [],
        summary,
        mock: !!data.mock,
      });
      setConfirmOpen(false);
      setResultsOpen(true);
      await fetchRecipients();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '발송 실패');
    } finally {
      setSending(false);
    }
  };

  const applyFilters = () => {
    setPage(1);
    fetchRecipients();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-blue-600" />
          <h1 className="text-xl font-semibold">답례품 알림톡 발송</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => openPreview()}
          disabled={previewLoading}
        >
          <Eye className="h-4 w-4" />
          샘플 미리보기
        </Button>
      </div>

      {/* 필터 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">필터</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div className="space-y-1.5">
            <Label htmlFor="start_date" className="text-xs">
              희망출고일 시작
            </Label>
            <Input
              id="start_date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="end_date" className="text-xs">
              희망출고일 종료
            </Label>
            <Input
              id="end_date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">발송 상태</Label>
            <Select
              value={sentStatus}
              onValueChange={(v) => setSentStatus(v as SentStatus)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                <SelectItem value="unsent">미발송</SelectItem>
                <SelectItem value="sent">발송됨</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-1">
            <Label htmlFor="search" className="text-xs">
              검색
            </Label>
            <Input
              id="search"
              placeholder="주문번호 / 수신자명"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters();
              }}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={applyFilters} className="w-full">
              적용
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={fetchRecipients}
              disabled={loading}
              title="새로고침"
            >
              <RefreshCw
                className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 요약 + 발송 버튼 */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-600">
          총 <span className="font-semibold">{total.toLocaleString()}</span>건
          {selectedIds.length > 0 && (
            <span className="ml-2 text-blue-600">
              (선택 {selectedIds.length}건)
            </span>
          )}
        </div>
        <Button
          onClick={openConfirm}
          disabled={selectedIds.length === 0 || sending || previewLoading}
          className="gap-1.5"
        >
          {previewLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          선택 발송 ({selectedIds.length})
        </Button>
      </div>

      {/* 테이블 */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSendableSelected}
                    onCheckedChange={toggleAll}
                    aria-label="전체 선택"
                  />
                </TableHead>
                <TableHead>주문번호</TableHead>
                <TableHead>수신자</TableHead>
                <TableHead>전화번호</TableHead>
                <TableHead>상품</TableHead>
                <TableHead>희망출고일</TableHead>
                <TableHead>수집일</TableHead>
                <TableHead>발송 이력</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-blue-500" />
                  </TableCell>
                </TableRow>
              ) : recipients.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-10 text-center text-sm text-gray-500"
                  >
                    조건에 맞는 답례품 주문이 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                recipients.map((r) => {
                  const selected = selectedIds.includes(r.order_id);
                  const hasPhone = !!r.recipient_phone;
                  return (
                    <TableRow
                      key={r.order_id}
                      data-state={selected ? 'selected' : undefined}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleOne(r.order_id)}
                          disabled={!hasPhone}
                          aria-label={`${r.order_number ?? r.order_id} 선택`}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.order_number ?? '-'}
                      </TableCell>
                      <TableCell>{r.recipient_name ?? '-'}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.recipient_phone ?? (
                          <span className="text-red-500">없음</span>
                        )}
                      </TableCell>
                      <TableCell
                        className="max-w-[220px] truncate"
                        title={r.product_name ?? ''}
                      >
                        {r.product_name ?? '-'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.desired_shipping_date
                          ? formatDateKo(r.desired_shipping_date)
                          : '-'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.collected_at ? formatDateKo(r.collected_at) : '-'}
                      </TableCell>
                      <TableCell>
                        {r.alimtalk_send_count > 0 ? (
                          <div className="flex flex-col gap-0.5">
                            <Badge variant="secondary" className="w-fit">
                              발송 {r.alimtalk_send_count}회
                            </Badge>
                            {r.last_alimtalk_sent_at && (
                              <span className="text-[10px] text-gray-500">
                                {formatDateTimeKo(r.last_alimtalk_sent_at)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline">미발송</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openPreview(r.order_id)}
                          title="미리보기"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            이전
          </Button>
          <span className="text-sm text-gray-600">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            다음
          </Button>
        </div>
      )}

      {/* 미리보기 다이얼로그 */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>알림톡 메시지 미리보기</DialogTitle>
          </DialogHeader>
          {previewData && (
            <div className="space-y-4">
              {previewData.sample && (
                <Badge variant="outline" className="text-xs">
                  샘플 데이터
                </Badge>
              )}
              <MessagePreviewCard preview={previewData} />
              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-500">템플릿 변수</p>
                <div className="rounded-md bg-gray-50 p-2 text-xs">
                  {Object.entries(previewData.variables).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <span className="text-gray-500">#{`{${k}}`}</span>
                      <span className="font-medium">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 발송 확인 다이얼로그 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>알림톡 일괄 발송</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  선택된 <b>{selectedIds.length}건</b>의 답례품 주문 고객에게 알림톡을
                  발송합니다. 발송 후 취소할 수 없습니다.
                </p>
                {confirmPreview && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-gray-500">
                      발송될 메시지 (첫 번째 건 예시)
                    </p>
                    <MessagePreviewCard preview={confirmPreview} />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={handleSend} disabled={sending}>
              {sending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {selectedIds.length}건 발송
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 발송 결과 다이얼로그 */}
      <Dialog open={resultsOpen} onOpenChange={setResultsOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>발송 결과</DialogTitle>
          </DialogHeader>
          {sendResultsData && (
            <SendResultsView
              data={sendResultsData}
              recipientMap={recipientMap}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Sub-components ────────────────────────────

function MessagePreviewCard({ preview }: { preview: PreviewData }) {
  return (
    <div className="rounded-lg border bg-yellow-50 p-3">
      <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-900">
        {preview.text}
      </pre>
      {preview.button && (
        <div className="mt-3 flex justify-center">
          <div className="rounded-md border border-yellow-300 bg-white px-4 py-1.5 text-xs font-medium text-yellow-800">
            {preview.button.name}
          </div>
        </div>
      )}
    </div>
  );
}

const SKIP_REASON_LABEL: Record<string, string> = {
  not_daeryepum: '답례품 아님',
  missing_phone: '전화번호 없음',
  order_not_found: '주문 없음',
};

function SendResultsView({
  data,
  recipientMap,
}: {
  data: { results: SendResult[]; summary: SendSummary; mock: boolean };
  recipientMap: Map<string, Recipient>;
}) {
  const { results, summary, mock } = data;

  return (
    <div className="flex flex-col gap-3 overflow-hidden">
      {/* 요약 카드 */}
      <div className="flex gap-3">
        <SummaryBadge label="전체" count={summary.total} variant="outline" />
        <SummaryBadge label="성공" count={summary.sent} variant="success" />
        {summary.failed > 0 && (
          <SummaryBadge label="실패" count={summary.failed} variant="destructive" />
        )}
        {summary.skipped > 0 && (
          <SummaryBadge label="스킵" count={summary.skipped} variant="warning" />
        )}
        {mock && (
          <Badge variant="outline" className="text-xs">Mock</Badge>
        )}
      </div>

      {/* 결과 테이블 */}
      <div className="overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>주문번호</TableHead>
              <TableHead>수신자</TableHead>
              <TableHead>결과</TableHead>
              <TableHead>상세</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((r) => {
              const recipient = recipientMap.get(r.order_id);
              return (
                <TableRow key={r.order_id}>
                  <TableCell className="font-mono text-xs">
                    {recipient?.order_number ?? r.order_id.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {recipient?.recipient_name ?? '-'}
                  </TableCell>
                  <TableCell>
                    {r.success ? (
                      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                        성공
                      </Badge>
                    ) : r.skipped_reason ? (
                      <Badge variant="outline" className="text-yellow-700 border-yellow-300">
                        스킵
                      </Badge>
                    ) : (
                      <Badge variant="destructive">실패</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-gray-500">
                    {r.success
                      ? r.message_id
                        ? `msgId: ${r.message_id}`
                        : ''
                      : r.skipped_reason
                        ? SKIP_REASON_LABEL[r.skipped_reason] ?? r.skipped_reason
                        : r.error ?? '알 수 없는 오류'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SummaryBadge({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant: 'outline' | 'success' | 'destructive' | 'warning';
}) {
  const colorClass =
    variant === 'success'
      ? 'bg-green-100 text-green-800 border-green-200'
      : variant === 'destructive'
        ? 'bg-red-100 text-red-800 border-red-200'
        : variant === 'warning'
          ? 'bg-yellow-100 text-yellow-800 border-yellow-200'
          : 'bg-gray-100 text-gray-800 border-gray-200';

  return (
    <div className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 ${colorClass}`}>
      <span className="text-xs">{label}</span>
      <span className="text-sm font-semibold">{count}</span>
    </div>
  );
}
