/**
 * Modèle métier pour le module Caisse Transimex
 * Colonnes : Check, Date, Libellé, Type de Transaction, Distribution Analytique (Matricule), Employé, QTE, Montant, Soldes
 */

export type TransactionTypeCategory = 'entree' | 'sortie';
export type TransactionStatus = 'draft' | 'posted' | 'cancelled';
export type Service = 'Opérations' | 'Administration';
export type CashierServiceType = Service;
export type CashierOperationType = Service; // Rétrocompatibilité

export interface CashierTransaction {
  id: string;
  date: string; // Format DD/MM/YYYY
  libelle: string; // Ex: "Carburant", "Frais généraux"
  service?: Service | string; // "Opérations" ou "Administration"
  typeDescription?: string; // Sous-texte descriptif
  category: TransactionTypeCategory; // entree (+) ou sortie (-)
  status?: TransactionStatus; // 'draft' (Brouillon) ou 'posted' (Comptabilisé)
  noDossier?: string; // Requis si service === 'Opérations' (ex: Matricule véhicule / Dossier)
  firstName?: string; // Optionnel pour rétrocompatibilité
  partenaire?: string; // Nom du partenaire ou de l'employé associé
  employee?: string; // Alias employé
  quantity?: number; // Quantité (QTE) - Requis si service === 'Opérations'
  montant: number; // Valeur numérique signée (positif ou négatif)
  soldeApres?: number; // Solde cumulé calculé
  selected?: boolean; // Case à cocher de sélection
}

export interface CashierFilterState {
  searchQuery: string;
  categoryFilter: 'all' | 'entree' | 'sortie';
  pageIndex: number;
  pageSize: number;
}
