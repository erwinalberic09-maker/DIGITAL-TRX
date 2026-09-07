import { Injectable, computed, inject, signal, effect, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  CashierFilterState,
  CashierTransaction,
} from '../models/cashier-transaction.model';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';

export interface CashierDbRow {
  id: string;
  date: string;
  libelle: string;
  type_transaction: string;
  type_description: string | null;
  category: 'entree' | 'sortie' | null;
  matricule_vehicule?: string | null;
  first_name: string | null;
  employee: string | null;
  quantity: number | null;
  montant: number;
  created_by?: string | null;
  created_at?: string;
}

@Injectable({
  providedIn: 'root',
})
export class CashierService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // Liste des transactions en Signal réactif
  private readonly _transactions = signal<CashierTransaction[]>([]);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);

  constructor() {
    // Réactivité automatique : recharger les transactions dès qu'un utilisateur est authentifié
    effect(() => {
      const user = this.authService.currentUser();
      if (user && this.isBrowser) {
        this.loadTransactions();
      }
    });
  }

  // Filtres et pagination
  private readonly _filterState = signal<CashierFilterState>({
    searchQuery: '',
    categoryFilter: 'all',
    pageIndex: 0,
    pageSize: 10,
  });

  // Signal pour piloter l'ouverture de la ligne d'ajout inline depuis le Layout
  public readonly isAddingRow = signal<boolean>(false);

  // États exposés en lecture seule
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());
  public readonly allTransactions = computed(() => this._transactions());

  // Transactions filtrées par mot-clé et type
  public readonly filteredTransactions = computed(() => {
    const query = this._filterState().searchQuery.trim().toLowerCase();
    const category = this._filterState().categoryFilter;
    const list = this._transactions();

    return list.filter((tx) => {
      const matchesCategory =
        category === 'all' || tx.category === category;
      if (!matchesCategory) return false;

      if (!query) return true;

      const searchableText = `${tx.libelle} ${tx.typeTransaction} ${tx.typeDescription || ''} ${tx.firstName || ''} ${tx.employee || ''} ${tx.matriculeVehicule || ''}`.toLowerCase();
      return searchableText.includes(query);
    });
  });

  // Calcul du solde actuel en temps réel
  public readonly currentBalance = computed(() => {
    const list = this._transactions();
    if (list.length === 0) return 0;
    return list.reduce((acc, curr) => acc + curr.montant, 0);
  });

  // Transactions paginées
  public readonly pagedTransactions = computed(() => {
    const filtered = this.filteredTransactions();
    const { pageIndex, pageSize } = this._filterState();
    const start = pageIndex * pageSize;
    return filtered.slice(start, start + pageSize);
  });

  // Total des éléments filtrés
  public readonly totalCount = computed(() => this.filteredTransactions().length);

  // Pagination calculée et formatée pour le Control Panel ERP (ex: "1-10 / 25" ou "0 / 0")
  public readonly paginationLabel = computed(() => {
    const total = this.totalCount();
    if (total === 0) return '0 / 0';
    const { pageIndex, pageSize } = this._filterState();
    const start = pageIndex * pageSize + 1;
    const end = Math.min((pageIndex + 1) * pageSize, total);
    return `${start}-${end} / ${total}`;
  });

  public readonly hasPrevPage = computed(() => this._filterState().pageIndex > 0);
  public readonly hasNextPage = computed(() => {
    const { pageIndex, pageSize } = this._filterState();
    return (pageIndex + 1) * pageSize < this.totalCount();
  });

  // État du filtre actuel en lecture seule
  public readonly filterState = computed(() => this._filterState());

  // Indique si toutes les transactions affichées sont sélectionnées
  public readonly isAllSelected = computed(() => {
    const currentList = this.pagedTransactions();
    return currentList.length > 0 && currentList.every((tx) => !!tx.selected);
  });

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 1. LECTURE HAUTE DISPONIBILITÉ : DOUBLE CANAL (API EXPRESS + REPLI DIRECT SUPABASE)
   * ───────────────────────────────────────────────────────────────────────────
   * Tente d'abord de récupérer les opérations via l'API Express rapide (/api/cahier/operations).
   * En cas d'indisponibilité ou d'erreur réseau, bascule immédiatement sur le SDK client Supabase.
   */
  public async loadTransactions(): Promise<void> {
    this._isLoading.set(true);
    this._error.set(null);

    let rawRows: CashierDbRow[] | null = null;
    const token = this.authService.token();

    // Canal 1 : API Express Serveur-Relais
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/cahier/operations', {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const resJson = await response.json();
        const ops = resJson.operations || resJson.transactions;
        if (Array.isArray(ops)) {
          rawRows = ops as CashierDbRow[];
        }
      }
    } catch (apiErr) {
      console.warn('API Express /api/cahier/operations injoignable, bascule sur le repli direct Supabase:', apiErr);
    }

    // Canal 2 (REPLI DE SECOURS) : Interrogation directe de Supabase SDK
    if (!rawRows) {
      try {
        await this.supabaseService.ensureInitialized();
        const client = this.supabaseService.supabase;

        if (client) {
          const { data, error } = await client
            .from('cashier_transactions')
            .select('*')
            .order('date', { ascending: false });

          if (!error && data && Array.isArray(data)) {
            rawRows = data as CashierDbRow[];
          }
        }
      } catch (supabaseErr) {
        console.warn('Échec du repli direct Supabase:', supabaseErr);
      }
    }

    // Traitement et injection dans le Signal Angular 19
    if (rawRows && Array.isArray(rawRows)) {
      const mappedTransactions = this.mapDatabaseOperations(rawRows);
      this._transactions.set(mappedTransactions);
    }

    this._isLoading.set(false);
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 2. SAUVEGARDE VIA API SERVEUR-RELAIS & RÉACTIVITÉ INSTANTANÉE VIA SIGNALS
   * ───────────────────────────────────────────────────────────────────────────
   * Sauvegarde une opération via POST /api/cahier/operations avec le JWT Bearer.
   * Dès réception de la confirmation, injecte l'opération dans le Signal _transactions.
   */
  public async saveOperationViaApi(
    op: Partial<CashierTransaction> | Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>
  ): Promise<{ success: boolean; operation?: CashierTransaction; error?: string }> {
    this._error.set(null);
    const token = this.authService.token();
    const currentSolde = this.currentBalance();
    const montant = Number(op.montant) || 0;
    const estimatedNewSolde = currentSolde + montant;

    let savedRow: CashierDbRow | null = null;

    // Étape 1 : Appel de l'API Serveur-Relais sécurisée
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/cahier/operations', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          libelle: op.libelle,
          typeTransaction: op.typeTransaction,
          typeDescription: op.typeDescription || null,
          category: op.category,
          matriculeVehicule: op.matriculeVehicule || null,
          firstName: op.firstName || null,
          employee: op.employee || null,
          quantity: op.quantity || 1,
          montant: op.montant,
          date: op.date ? new Date(op.date).toISOString() : new Date().toISOString(),
        }),
      });

      if (response.ok) {
        const resJson = await response.json();
        savedRow = (resJson.operation || resJson.transaction) as CashierDbRow;
      } else {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Erreur serveur ${response.status}`);
      }
    } catch (apiErr: unknown) {
      console.warn('Appel API /api/cahier/operations échoué, tentative via client Supabase direct:', apiErr);

      // Étape 2 (REPLI) : Sauvegarde directe via client Supabase si API injoignable
      try {
        await this.supabaseService.ensureInitialized();
        const client = this.supabaseService.supabase;
        if (client) {
          const currentUser = this.authService.currentUser();
          const { data, error } = await client
            .from('cashier_transactions')
            .insert([
              {
                libelle: op.libelle,
                type_transaction: op.typeTransaction,
                type_description: op.typeDescription || null,
                category: op.category,
                matricule_vehicule: op.matriculeVehicule || null,
                first_name: op.firstName || null,
                employee: op.employee || null,
                quantity: op.quantity || 1,
                montant: op.montant,
                created_by: currentUser?.id || null,
              },
            ])
            .select()
            .single();

          if (!error && data) {
            savedRow = data as CashierDbRow;
          }
        }
      } catch (directErr) {
        console.warn('Échec du repli direct Supabase insert:', directErr);
      }
    }

    // Étape 3 : Création de l'objet transaction unifié
    const operationToStore: CashierTransaction = savedRow
      ? {
          id: savedRow.id,
          date: this.formatDate(savedRow.date || new Date().toISOString()),
          libelle: savedRow.libelle,
          typeTransaction: savedRow.type_transaction,
          typeDescription: savedRow.type_description || '',
          category: savedRow.category as 'entree' | 'sortie',
          matriculeVehicule: savedRow.matricule_vehicule || '',
          firstName: savedRow.first_name || '',
          employee: savedRow.employee || '',
          quantity: savedRow.quantity ? Number(savedRow.quantity) : undefined,
          montant: Number(savedRow.montant),
          soldeApres: estimatedNewSolde,
          selected: false,
        }
      : {
          id: `tx-${Date.now()}`,
          date: this.formatDate(op.date || new Date().toISOString()),
          libelle: op.libelle || 'Opération',
          typeTransaction: op.typeTransaction || '',
          typeDescription: op.typeDescription || '',
          category: (op.category || (montant >= 0 ? 'entree' : 'sortie')) as 'entree' | 'sortie',
          matriculeVehicule: op.matriculeVehicule || '',
          firstName: op.firstName || '',
          employee: op.employee || '',
          quantity: op.quantity,
          montant,
          soldeApres: estimatedNewSolde,
          selected: false,
        };

    // Étape 4 (RÉACTIVITÉ INSTANTANÉE) : Mise à jour immédiate du Signal Angular 19
    this._transactions.update((currentOps) => [operationToStore, ...currentOps]);
    this.recalculateRunningBalances();

    return { success: true, operation: operationToStore };
  }

  /**
   * Alias rétrocompatible pour l'ajout d'une transaction
   */
  public async addTransaction(
    newTx: Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>
  ): Promise<boolean> {
    const result = await this.saveOperationViaApi(newTx);
    return result.success;
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 2b. MODIFICATION D'UNE TRANSACTION : API RELAIS AVEC REPLI ET RÉACTIVITÉ
   * ───────────────────────────────────────────────────────────────────────────
   */
  public async updateTransaction(
    id: string,
    updatedFields: Partial<Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>>
  ): Promise<{ success: boolean; message?: string }> {
    this._error.set(null);
    const token = this.authService.token();

    // 1. Convertir la date affichée (ex: "05/09/2026") en ISO si besoin
    let isoDate: string | undefined;
    if (updatedFields.date) {
      const parts = updatedFields.date.split('/');
      if (parts.length === 3) {
        isoDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).toISOString();
      } else {
        isoDate = new Date(updatedFields.date).toISOString();
      }
    }

    // 2. Appel vers l'API serveur-relais
    let updatedViaApi = false;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const bodyPayload: Record<string, unknown> = {};
      if (updatedFields.libelle !== undefined) bodyPayload['libelle'] = updatedFields.libelle;
      if (updatedFields.typeTransaction !== undefined) bodyPayload['typeTransaction'] = updatedFields.typeTransaction;
      if (updatedFields.typeDescription !== undefined) bodyPayload['typeDescription'] = updatedFields.typeDescription;
      if (updatedFields.category !== undefined) bodyPayload['category'] = updatedFields.category;
      if (updatedFields.matriculeVehicule !== undefined) bodyPayload['matriculeVehicule'] = updatedFields.matriculeVehicule;
      if (updatedFields.firstName !== undefined) bodyPayload['firstName'] = updatedFields.firstName;
      if (updatedFields.employee !== undefined) bodyPayload['employee'] = updatedFields.employee;
      if (updatedFields.quantity !== undefined) bodyPayload['quantity'] = updatedFields.quantity;
      if (updatedFields.montant !== undefined) bodyPayload['montant'] = updatedFields.montant;
      if (isoDate) bodyPayload['date'] = isoDate;

      const response = await fetch(`/api/cahier/operations/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(bodyPayload),
      });

      if (response.ok) {
        updatedViaApi = true;
      }
    } catch (apiErr) {
      console.warn('Appel API update /api/cahier/operations échoué, tentative via client Supabase direct:', apiErr);
    }

    // 3. Repli direct Supabase si l'API Express n'a pas répondu
    if (!updatedViaApi) {
      try {
        await this.supabaseService.ensureInitialized();
        const client = this.supabaseService.supabase;
        if (client) {
          const directPayload: Record<string, unknown> = {};
          if (updatedFields.libelle !== undefined) directPayload['libelle'] = updatedFields.libelle;
          if (updatedFields.typeTransaction !== undefined) directPayload['type_transaction'] = updatedFields.typeTransaction;
          if (updatedFields.typeDescription !== undefined) directPayload['type_description'] = updatedFields.typeDescription || null;
          if (updatedFields.category !== undefined) directPayload['category'] = updatedFields.category;
          if (updatedFields.matriculeVehicule !== undefined) directPayload['matricule_vehicule'] = updatedFields.matriculeVehicule || null;
          if (updatedFields.firstName !== undefined) directPayload['first_name'] = updatedFields.firstName || null;
          if (updatedFields.employee !== undefined) directPayload['employee'] = updatedFields.employee || null;
          if (updatedFields.quantity !== undefined) directPayload['quantity'] = updatedFields.quantity;
          if (updatedFields.montant !== undefined) directPayload['montant'] = updatedFields.montant;
          if (isoDate) directPayload['date'] = isoDate;

          await client
            .from('cashier_transactions')
            .update(directPayload)
            .eq('id', id);
        }
      } catch (directErr) {
        console.warn('Échec du repli direct Supabase update:', directErr);
      }
    }

    // 4. Mise à jour immédiate du Signal Angular 19 et recalcul des soldes cumulés
    this._transactions.update((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          ...updatedFields,
          date: updatedFields.date || item.date,
          montant: updatedFields.montant !== undefined ? updatedFields.montant : item.montant,
        };
      })
    );

    this.recalculateRunningBalances();
    return { success: true, message: 'Transaction modifiée avec succès' };
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 3. SUPPRESSION D'OPÉRATIONS : API RELAIS AVEC REPLI ET RÉACTIVITÉ
   * ───────────────────────────────────────────────────────────────────────────
   */
  public async deleteSelected(): Promise<boolean> {
    const selectedIds = this._transactions()
      .filter((t) => t.selected)
      .map((t) => t.id);

    if (selectedIds.length === 0) return true;

    this._error.set(null);
    const token = this.authService.token();

    // 1. Tente d'abord de supprimer via l'API Express
    let deletedViaApi = false;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/api/cahier/operations', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ ids: selectedIds }),
      });

      if (response.ok) {
        deletedViaApi = true;
      }
    } catch {
      // Ignorer l'erreur réseau et tenter le repli direct
    }

    // 2. Repli direct Supabase si l'API n'a pas pu traiter la demande
    if (!deletedViaApi) {
      try {
        await this.supabaseService.ensureInitialized();
        const client = this.supabaseService.supabase;
        if (client) {
          await client
            .from('cashier_transactions')
            .delete()
            .in('id', selectedIds);
        }
      } catch (err) {
        console.warn('Erreur lors de la suppression directe Supabase:', err);
      }
    }

    // 3. Mise à jour immédiate du Signal Angular 19
    this._transactions.update((items) => items.filter((item) => !item.selected));
    this.recalculateRunningBalances();
    return true;
  }

  /**
   * Recalcule les soldes progressifs de manière chronologique
   */
  private recalculateRunningBalances(): void {
    const current = this._transactions();
    if (current.length === 0) return;

    let balance = 0;
    const chronological = [...current].reverse();
    const updated = chronological.map((tx) => {
      balance += tx.montant;
      return { ...tx, soldeApres: balance };
    });

    this._transactions.set(updated.reverse());
  }

  /**
   * Mappe les enregistrements de la base de données vers le modèle applicatif
   */
  public mapDatabaseOperations(rows: CashierDbRow[]): CashierTransaction[] {
    let runningBalance = 0;
    const chronological = [...rows].reverse();

    const mappedChronological = chronological.map((row) => {
      const numMontant = Number(row.montant) || 0;
      runningBalance += numMontant;
      return {
        id: row.id,
        date: this.formatDate(row.date),
        libelle: row.libelle || '',
        typeTransaction: row.type_transaction || '',
        typeDescription: row.type_description || '',
        category: (row.category || (numMontant >= 0 ? 'entree' : 'sortie')) as 'entree' | 'sortie',
        matriculeVehicule: row.matricule_vehicule || '',
        firstName: row.first_name || '',
        employee: row.employee || '',
        quantity: row.quantity !== null && row.quantity !== undefined ? Number(row.quantity) : undefined,
        montant: numMontant,
        soldeApres: runningBalance,
        selected: false,
      } as CashierTransaction;
    });

    return mappedChronological.reverse();
  }

  public startAddTransaction(): void {
    this.isAddingRow.set(true);
  }

  public cancelAddTransaction(): void {
    this.isAddingRow.set(false);
  }

  public prevPage(): void {
    this._filterState.update((state) => ({
      ...state,
      pageIndex: Math.max(0, state.pageIndex - 1),
    }));
  }

  public nextPage(): void {
    const total = this.totalCount();
    const { pageIndex, pageSize } = this._filterState();
    if ((pageIndex + 1) * pageSize < total) {
      this._filterState.update((state) => ({
        ...state,
        pageIndex: state.pageIndex + 1,
      }));
    }
  }

  public setSearchQuery(query: string): void {
    this._filterState.update((state) => ({
      ...state,
      searchQuery: query,
      pageIndex: 0,
    }));
  }

  public setCategoryFilter(category: 'all' | 'entree' | 'sortie'): void {
    this._filterState.update((state) => ({
      ...state,
      categoryFilter: category,
      pageIndex: 0,
    }));
  }

  public setPageIndex(index: number): void {
    this._filterState.update((state) => ({
      ...state,
      pageIndex: Math.max(0, index),
    }));
  }

  public toggleSelectTransaction(id: string): void {
    this._transactions.update((items) =>
      items.map((item) =>
        item.id === id ? { ...item, selected: !item.selected } : item
      )
    );
  }

  public toggleSelectAll(select: boolean): void {
    const displayedIds = new Set(this.pagedTransactions().map((t) => t.id));
    this._transactions.update((items) =>
      items.map((item) =>
        displayedIds.has(item.id) ? { ...item, selected: select } : item
      )
    );
  }

  private formatDate(dateStr: string): string {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    } catch {
      return dateStr;
    }
  }
}
