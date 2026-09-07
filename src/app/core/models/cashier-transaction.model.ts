/**
 * Modèle métier pour le module Caisse Transimex
 * Colonnes : Check, Date, Libellé, Type de Transaction, Distribution Analytique (Matricule), Employé, QTE, Montant, Soldes
 */

export type TransactionTypeCategory = 'entree' | 'sortie';
export type CashierOperationType = 'Opérations' | 'Administration';

export interface CashierTransaction {
  id: string;
  date: string; // Format DD/MM/YYYY
  libelle: string; // Ex: "Carburant", "Frais généraux"
  typeTransaction: CashierOperationType | string; // "Opérations" ou "Administration"
  typeDescription?: string; // Sous-texte descriptif
  category: TransactionTypeCategory; // entree (+) ou sortie (-)
  matriculeVehicule?: string; // Requis si typeTransaction === 'Opérations' (Distribution analytique)
  firstName?: string; // Optionnel pour rétrocompatibilité
  employee?: string; // Nom de l'employé associé
  quantity?: number; // Quantité (QTE) - Requis si typeTransaction === 'Opérations'
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
