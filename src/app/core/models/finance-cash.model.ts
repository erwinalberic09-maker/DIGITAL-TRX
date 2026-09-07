// ============================================================================
// MODÈLE ERP TRANSMEX : CAISSE, BANQUE & DÉPENSES
// Tables : cash_registers, cash_movements, receipts, receipt_items,
//          bank_accounts, bank_transactions, expenses
// ============================================================================

export type CashRegisterStatus = 'ouvert' | 'ferme' | 'en_cloture' | 'bloque';
export type CashMovementType = 'fond_de_caisse' | 'encaissement_especes' | 'decaissement' | 'depot_banque' | 'ajustement';
export type BankAccountType = 'courant' | 'epargne' | 'coffre' | 'devises';
export type ExpenseCategory = 'carburant' | 'maintenance_flotte' | 'loyer' | 'fournitures' | 'salaires' | 'repas' | 'taxes' | 'autre';
export type ExpenseStatus = 'brouillon' | 'soumis' | 'approuve' | 'rejete' | 'rembourse';

/**
 * Table : cash_registers
 * Caisses physiques et sessions de vente POS
 */
export interface CashRegister {
  id: string;
  name: string; // Ex: "Caisse Principale Dépôt 1"
  code: string; // Ex: "CAISSE-01"
  cashierId?: string; // Clé étrangère vers employees(id)
  openingBalance: number; // Montant d'ouverture en espèces
  currentBalance: number; // Solde théorique actuel
  closingBalance?: number; // Solde réel compté à la clôture
  status: CashRegisterStatus;
  openedAt: string;
  closedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  cashierName?: string;
}

/**
 * Table : cash_movements
 * Flux physiques d'espèces en caisse
 */
export interface CashMovement {
  id: string;
  cashRegisterId: string; // Clé étrangère vers cash_registers(id)
  movementType: CashMovementType;
  amount: number; // Montant positif
  reason: string;
  receiptId?: string; // Liaison optionnelle vers un ticket/reçu
  createdById: string; // Clé étrangère vers profiles(id)
  createdAt: string;
  // Propriétés jointes
  cashRegisterName?: string;
  createdByName?: string;
}

/**
 * Table : receipts
 * Reçus et tickets de vente POS au comptoir
 */
export interface Receipt {
  id: string;
  receiptNumber: string; // Ex: "REC-2026-0891"
  cashRegisterId: string; // Clé étrangère vers cash_registers(id)
  totalAmount: number;
  paidAmount: number;
  changeGiven: number; // Rendu de monnaie
  paymentMethod: 'especes' | 'carte_bancaire' | 'cheque' | 'mobile_money';
  createdById: string; // Clé étrangère vers profiles(id)
  createdAt: string;
  // Propriétés jointes
  createdByName?: string;
  items?: ReceiptItem[];
}

/**
 * Table : receipt_items
 * Détail des articles encaissés sur ticket
 */
export interface ReceiptItem {
  id: string;
  receiptId: string; // Clé étrangère vers receipts(id)
  productId: string; // Clé étrangère vers products(id)
  quantity: number;
  unitPrice: number;
  vatRate: number;
  totalLineAmount: number;
  // Propriétés jointes
  productName?: string;
  productSku?: string;
}

/**
 * Table : bank_accounts
 * Comptes bancaires professionnels de l'entreprise
 */
export interface BankAccount {
  id: string;
  bankName: string; // Ex: "Banque Nationale de Paris"
  accountName: string; // Ex: "Compte Opérationnel Transmex"
  accountNumber: string;
  iban?: string;
  bicSwift?: string;
  currency: string; // Ex: "EUR", "XOF", "USD"
  currentBalance: number;
  accountType: BankAccountType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Table : bank_transactions
 * Relevés et opérations bancaires
 */
export interface BankTransaction {
  id: string;
  bankAccountId: string; // Clé étrangère vers bank_accounts(id)
  transactionDate: string;
  valueDate?: string;
  description: string;
  referenceNumber?: string;
  transactionType: 'credit' | 'debit';
  amount: number;
  runningBalanceAfter: number;
  isReconciled: boolean; // Rapprochement bancaire validé
  createdById: string; // Clé étrangère vers profiles(id)
  createdAt: string;
  // Propriétés jointes
  bankAccountName?: string;
  createdByName?: string;
}

/**
 * Table : expenses
 * Notes de frais, carburant, maintenance et dépenses
 */
export interface Expense {
  id: string;
  departmentId?: string; // Clé étrangère vers departments(id)
  expenseDate: string;
  category: ExpenseCategory;
  amount: number;
  vatAmount?: number;
  paymentMethod: 'especes' | 'carte_societe' | 'virement' | 'remboursement_collaborateur';
  merchantName: string; // Ex: "Station Total", "Garage Mécanique"
  description: string;
  receiptAttachmentUrl?: string; // Justificatif
  status: ExpenseStatus;
  createdById: string; // Clé étrangère vers profiles(id)
  approvedById?: string; // Clé étrangère vers profiles(id)
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  departmentName?: string;
  createdByName?: string;
  approverName?: string;
}
