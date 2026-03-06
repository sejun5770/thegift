export interface Product {
  id: string;
  product_code: string;
  product_name: string;
  price: number;
  is_sticker_product: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface StickerType {
  id: string;
  sticker_code: string;
  sticker_name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductStickerMapping {
  id: string;
  product_id: string;
  sticker_type_id: string;
  slot_number: number;
  is_active: boolean;
  created_at: string;
  // Relations
  sticker_type?: StickerType;
}

export interface BoxType {
  id: string;
  box_code: string;
  box_name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
