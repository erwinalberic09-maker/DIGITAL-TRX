// ============================================================================
// MODÈLE ERP TRANSMEX : ACHATS, VENTES & FACTURATION
// Tables : clients, suppliers, purchase_orders, purchase_order_items,
//          sales_orders, sales_order_items, invoices, invoice_items
// ============================================================================

export type OrderStatus = 'brouillon' | 'confirme' | 'en_traitement' | 'livre' | 'annule';
export type InvoiceStatus = 'brouillon' | 'emise' | 'partiellement_payee' | 'payee' | 'en_retard' | 'annulee';
export type PaymentMethod = 'virement' | 'carte_bancaire' | 'cheque' | 'especes' | 'traite';

/**
 * Table : clients
 * Annuaire et comptes clients B2B / B2C
 */
export interface Client {
  id: string;
  code: string; // Ex: "CLI-00124"
  name: string;
  companyName?: string;
  taxNumber?: string; // N° TVA / SIRET / NIF
  email: string;
  phone?: string;
  billingAddress: string;
  shippingAddress?: string;
  city?: string;
  country?: string;
  paymentTermsDays: number; // Ex: 30 jours
  creditLimit?: number;
  outstandingBalance: number; // Solde dû actuel
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Table : suppliers
 * Annuaire des fournisseurs et partenaires
 */
export interface Supplier {
  id: string;
  code: string; // Ex: "FRN-00089"
  name: string;
  companyName: string;
  taxNumber?: string;
  email: string;
  phone?: string;
  address: string;
  city?: string;
  country?: string;
  contactPerson?: string;
  paymentTermsDays: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Table : purchase_orders
 * Bons de commande d'achat fournisseur
 */
export interface PurchaseOrder {
  id: string;
  orderNumber: string; // Ex: "BC-2026-0034"
  supplierId: string; // Clé étrangère vers suppliers(id)
  orderDate: string;
  expectedDeliveryDate?: string;
  status: OrderStatus;
  subtotalAmount: number; // Total HT
  vatAmount: number; // Total TVA
  totalAmount: number; // Total TTC
  notes?: string;
  createdById: string; // Clé étrangère vers profiles(id)
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  supplierName?: string;
  createdByName?: string;
  items?: PurchaseOrderItem[];
}

/**
 * Table : purchase_order_items
 * Lignes de commande d'achat
 */
export interface PurchaseOrderItem {
  id: string;
  purchaseOrderId: string; // Clé étrangère vers purchase_orders(id)
  productId: string; // Clé étrangère vers products(id)
  quantity: number;
  unitPrice: number; // Prix unitaire HT
  vatRate: number;
  discountPercentage: number;
  totalLineAmount: number; // Total HT de la ligne
  // Propriétés jointes
  productName?: string;
  productSku?: string;
}

/**
 * Table : sales_orders
 * Commandes de vente clients
 */
export interface SalesOrder {
  id: string;
  orderNumber: string; // Ex: "CMD-2026-0158"
  clientId: string; // Clé étrangère vers clients(id)
  orderDate: string;
  deliveryDate?: string;
  status: OrderStatus;
  subtotalAmount: number;
  vatAmount: number;
  totalAmount: number;
  paymentTerms?: string;
  notes?: string;
  createdById: string; // Clé étrangère vers profiles(id)
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  clientName?: string;
  createdByName?: string;
  items?: SalesOrderItem[];
}

/**
 * Table : sales_order_items
 * Lignes de commande de vente
 */
export interface SalesOrderItem {
  id: string;
  salesOrderId: string; // Clé étrangère vers sales_orders(id)
  productId: string; // Clé étrangère vers products(id)
  quantity: number;
  unitPrice: number;
  vatRate: number;
  discountPercentage: number;
  totalLineAmount: number;
  // Propriétés jointes
  productName?: string;
  productSku?: string;
}

/**
 * Table : invoices
 * Factures officielles de vente et avoirs
 */
export interface Invoice {
  id: string;
  invoiceNumber: string; // Ex: "FAC-2026-0045"
  salesOrderId?: string; // Clé étrangère optionnelle vers sales_orders(id)
  clientId: string; // Clé étrangère vers clients(id)
  invoiceDate: string;
  dueDate: string;
  status: InvoiceStatus;
  subtotalAmount: number;
  vatAmount: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  paymentMethod?: PaymentMethod;
  notes?: string;
  createdById: string; // Clé étrangère vers profiles(id)
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  clientName?: string;
  createdByName?: string;
  items?: InvoiceItem[];
}

/**
 * Table : invoice_items
 * Lignes détaillées de facture
 */
export interface InvoiceItem {
  id: string;
  invoiceId: string; // Clé étrangère vers invoices(id)
  productId?: string; // Clé étrangère vers products(id)
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  discountPercentage: number;
  totalLineAmount: number;
  // Propriétés jointes
  productName?: string;
  productSku?: string;
}
