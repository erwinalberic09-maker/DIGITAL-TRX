// ============================================================================
// MODÈLE ERP TRANSMEX : COMPTABILITÉ GÉNÉRALE & RAPPORTS
// Tables : account_chart, journal_entries, journal_entry_lines, reports
// ============================================================================

export type AccountClass = '1_capitaux' | '2_immobilisations' | '3_stocks' | '4_tiers' | '5_financiers' | '6_charges' | '7_produits';
export type AccountType = 'actif' | 'passif' | 'charge' | 'produit';
export type JournalType = 'achats' | 'ventes' | 'banque' | 'caisse' | 'operations_diverses';
export type ReportType = 'bilan' | 'compte_resultat' | 'balance_generale' | 'grand_livre' | 'tresorerie_journaliere' | 'tva_mensuelle';
export type ReportStatus = 'genere' | 'valide' | 'archive';

/**
 * Table : account_chart
 * Plan comptable général de l'entreprise
 */
export interface AccountChart {
  id: string;
  accountNumber: string; // Ex: "401000", "512000", "707000"
  label: string; // Ex: "Fournisseurs", "Banque BNP", "Ventes de marchandises"
  accountClass: AccountClass;
  accountType: AccountType;
  parentAccountId?: string; // Auto-référence optionnelle pour sous-comptes
  isReconcilable: boolean; // Lettrage comptable possible
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Table : journal_entries
 * Pièces et écritures dans le journal comptable
 */
export interface JournalEntry {
  id: string;
  entryNumber: string; // Ex: "ECR-2026-00342"
  journalType: JournalType;
  entryDate: string; // Date de valeur comptable
  referenceDocument?: string; // Ex: "FAC-2026-0045"
  description: string;
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean; // Débit == Crédit
  isPosted: boolean; // Validé définitivement (non modifiable)
  createdById: string; // Clé étrangère vers profiles(id)
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  createdByName?: string;
  lines?: JournalEntryLine[];
}

/**
 * Table : journal_entry_lines
 * Lignes de débit / crédit comptables
 */
export interface JournalEntryLine {
  id: string;
  journalEntryId: string; // Clé étrangère vers journal_entries(id)
  accountId: string; // Clé étrangère vers account_chart(id)
  label: string;
  debitAmount: number; // >= 0
  creditAmount: number; // >= 0
  matchingCode?: string; // Code de lettrage (ex: "AA")
  createdAt: string;
  // Propriétés jointes
  accountNumber?: string;
  accountLabel?: string;
}

/**
 * Table : reports
 * Bilans, états financiers et rapports analytiques générés
 */
export interface FinancialReport {
  id: string;
  reportNumber: string; // Ex: "RAP-2026-Q1"
  title: string;
  reportType: ReportType;
  periodStartDate: string;
  periodEndDate: string;
  parameters?: Record<string, unknown>; // Filtres JSON appliqués
  summaryData?: Record<string, unknown>; // Données chiffrées de synthèse
  filePdfUrl?: string;
  fileExcelUrl?: string;
  status: ReportStatus;
  generatedById: string; // Clé étrangère vers profiles(id)
  approvedById?: string; // Clé étrangère vers profiles(id)
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  generatedByName?: string;
  approverName?: string;
}
