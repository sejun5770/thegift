'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { StickerList } from '@/components/barungift/admin/StickerList';
import { StickerForm } from '@/components/barungift/admin/StickerForm';
import type { BgSticker } from '@/lib/barungift/types';

export default function StickersAdminPage() {
  const [stickers, setStickers] = useState<BgSticker[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSticker, setEditingSticker] = useState<BgSticker | null>(null);
  const [showForm, setShowForm] = useState(false);

  const fetchStickers = useCallback(async () => {
    try {
      const res = await fetch('/c/barungift/api/stickers');
      const data = await res.json();
      setStickers(data.stickers || []);
    } catch {
      toast.error('스티커 목록을 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStickers();
  }, [fetchStickers]);

  const handleCreate = () => {
    setEditingSticker(null);
    setShowForm(true);
  };

  const handleEdit = (sticker: BgSticker) => {
    setEditingSticker(sticker);
    setShowForm(true);
  };

  const handleSave = async (data: Partial<BgSticker>) => {
    const isEdit = !!editingSticker;
    const url = isEdit
      ? `/c/barungift/api/stickers/${editingSticker!.id}`
      : '/c/barungift/api/stickers';
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || '저장에 실패했습니다.');
      throw new Error(err.error);
    }

    toast.success(isEdit ? '스티커가 수정되었습니다.' : '스티커가 생성되었습니다.');
    fetchStickers();
  };

  const handleDelete = async (stickerId: string) => {
    if (!confirm('이 스티커를 비활성화하시겠습니까?')) return;

    try {
      const res = await fetch(`/c/barungift/api/stickers/${stickerId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        toast.error('삭제에 실패했습니다.');
        return;
      }

      toast.success('스티커가 비활성화되었습니다.');
      fetchStickers();
    } catch {
      toast.error('삭제에 실패했습니다.');
    }
  };

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">바른기프트 스티커 관리</h1>
          <p className="text-sm text-gray-500">
            고객이 선택할 수 있는 스티커 템플릿을 관리합니다.
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="mr-1 h-4 w-4" />
          스티커 생성
        </Button>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : (
        <StickerList
          stickers={stickers}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      )}

      {/* 생성/수정 폼 */}
      {showForm && (
        <StickerForm
          sticker={editingSticker}
          open={showForm}
          onClose={() => setShowForm(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
