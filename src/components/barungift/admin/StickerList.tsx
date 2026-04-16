'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { BgSticker } from '@/lib/barungift/types';

interface StickerListProps {
  stickers: BgSticker[];
  onEdit: (sticker: BgSticker) => void;
  onDelete: (stickerId: string) => void;
}

export function StickerList({ stickers, onEdit, onDelete }: StickerListProps) {
  if (stickers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <p className="text-sm">등록된 스티커가 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[11px]">미리보기</TableHead>
            <TableHead className="text-[11px]">스티커명</TableHead>
            <TableHead className="text-[11px]">커스텀영역</TableHead>
            <TableHead className="text-[11px]">상태</TableHead>
            <TableHead className="text-[11px]">생성일</TableHead>
            <TableHead className="text-[11px] text-right">관리</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stickers.map((sticker) => (
            <TableRow key={sticker.id}>
              <TableCell>
                <div
                  className="h-10 w-8 rounded border"
                  style={{
                    backgroundColor: sticker.preview_color,
                    backgroundImage: sticker.preview_image_url
                      ? `url(${sticker.preview_image_url})`
                      : undefined,
                    backgroundSize: 'cover',
                  }}
                />
              </TableCell>
              <TableCell className="text-sm font-medium">
                {sticker.name}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {sticker.custom_fields.length}개
              </TableCell>
              <TableCell>
                <Badge variant={sticker.is_active ? 'default' : 'secondary'}>
                  {sticker.is_active ? '활성' : '비활성'}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-gray-500">
                {new Date(sticker.created_at).toLocaleDateString('ko-KR')}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(sticker)}
                    className="h-7 w-7 p-0"
                  >
                    <Pencil className="h-3.5 w-3.5 text-gray-500" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(sticker.id)}
                    className="h-7 w-7 p-0"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-red-400" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
