'use client';

import type { BgSticker } from '@/lib/barungift/types';

interface StickerPreviewProps {
  sticker: BgSticker;
  customValues: Record<string, string>;
  className?: string;
}

export function StickerPreview({
  sticker,
  customValues,
  className = '',
}: StickerPreviewProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border ${className}`}
      style={{
        aspectRatio: '3 / 4',
        backgroundColor: sticker.preview_color || '#FFFFFF',
        backgroundImage: sticker.preview_image_url
          ? `url(${sticker.preview_image_url})`
          : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* 스티커명 (이미지 없을 때) */}
      {!sticker.preview_image_url && (
        <div className="absolute inset-0 flex items-start justify-center pt-4">
          <span className="text-xs font-medium text-gray-400">{sticker.name}</span>
        </div>
      )}

      {/* 커스텀 필드 오버레이 */}
      {sticker.custom_fields.map((field) => {
        const value = customValues[field.field_id] || '';
        return (
          <div
            key={field.field_id}
            className="absolute flex items-center justify-center"
            style={{
              left: `${field.position.x}%`,
              top: `${field.position.y}%`,
              width: `${field.position.w}%`,
              height: `${field.position.h}%`,
              fontSize: field.font_size ? `${field.font_size}px` : '12px',
              fontFamily: field.font_family || 'inherit',
            }}
          >
            {value ? (
              <span className="truncate text-center leading-tight text-gray-800">
                {value}
              </span>
            ) : (
              <span className="truncate text-center leading-tight text-gray-300 italic text-[10px]">
                {field.field_label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
