// ============================================================================
// MODÈLE ERP TRANSMEX : PRODUITS, RÉPERTOIRE & STOCKS
// Tables : product_categories, products, inventory, stock_movements
// ============================================================================

export type StockMovementType = 'entree_achat' | 'sortie_vente' | 'ajustement_inventaire' | 'transfert' | 'rebut' | 'retour_client';
export type ProductUnit = 'piece' | 'kg' | 'litre' | 'carton' | 'palette' | 'metre' | 'paquet';

/**
 * Table : product_categories
 * Arborescence des catégories d'articles
 */
export interface ProductCategory {
  id: string;
  name: string;
  code: string;
  description?: string;
  parentCategoryId?: string; // Clé étrangère auto-référentielle vers product_categories(id)
  parentCategoryName?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Table : products
 * Catalogue des articles et marchandises
 */
export interface Product {
  id: string;
  categoryId: string; // Clé étrangère vers product_categories(id)
  supplierId?: string; // Clé étrangère vers suppliers(id)
  sku: string; // Référence / Code-barres unique
  name: string;
  description?: string;
  unit: ProductUnit;
  purchasePrice: number; // Prix d'achat HT
  sellingPrice: number; // Prix de vente unitaire HT
  vatRate: number; // Taux TVA (ex: 20.0 pour 20%)
  minStockAlert: number; // Seuil d'alerte de réapprovisionnement
  idealStock: number;
  imageUrl?: string;
  barcode?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  categoryName?: string;
  supplierName?: string;
  currentStock?: number;
}

/**
 * Table : inventory
 * Niveaux de stocks actuels et emplacements par entrepôt / rayon
 */
export interface Inventory {
  id: string;
  productId: string; // Clé étrangère vers products(id)
  warehouseLocation?: string; // Ex: "Entrepôt A - Allée 3 - Rack B"
  quantityAvailable: number;
  quantityReserved: number; // Quantité engagée sur commandes en cours
  quantityIncoming: number; // Quantité en cours de livraison fournisseur
  lastCountedAt?: string;
  updatedAt: string;
  // Propriétés jointes
  productName?: string;
  productSku?: string;
  productUnit?: ProductUnit;
  isLowStock?: boolean;
}

/**
 * Table : stock_movements
 * Traçabilité et historique de tous les flux de stock
 */
export interface StockMovement {
  id: string;
  productId: string; // Clé étrangère vers products(id)
  movementType: StockMovementType;
  quantity: number; // Positif pour entrée, négatif pour sortie
  previousStock: number;
  newStock: number;
  unitCost?: number;
  referenceDocument?: string; // Ex: "BL-2026-0045" ou "FACTURE-982"
  reason?: string;
  createdById?: string; // Clé étrangère vers profiles(id)
  createdByName?: string;
  createdAt: string;
  // Propriétés jointes
  productName?: string;
  productSku?: string;
}
