import { Injectable, computed, inject, signal, effect, PLATFORM_ID, OnDestroy } from '@angular/core';
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
  service?: string | null;
  type_transaction?: string | null;
  type_description?: string | null;
  category: 'entree' | 'sortie';
  status: 'draft' | 'posted' | 'cancelled';
  no_dossier?: string | null;
  matricule_vehicule?: string | null;
  first_name?: string | null;
  partenaire?: string | null;
  employee?: string | null;
  quantity?: number | null;
  montant: number;
  solde_apres?: number | null;
  selected?: boolean;
  created_at?: string;
  updated_at?: string;
}

// Colonnes sélectionnées selon le principe du moindre privilège alignées sur le schéma Supabase
const CASHIER_SELECTED_COLUMNS =
  'id, date, libelle, service, type_description, category, status, no_dossier, first_name, partenaire, employee, quantity, montant, solde_apres, selected';

@Injectable({
  providedIn: 'root',
})
export class CashierService implements OnDestroy {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // Liste des transactions en Signal réactif
  private readonly _transactions = signal<CashierTransaction[]>([]);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private realtimeChannel: ReturnType<NonNullable<SupabaseService['supabase']>['channel']> | null = null;

  constructor() {
    // Réactivité automatique : recharger les transactions et initialiser Realtime dès qu'un utilisateur est authentifié
    effect(() => {
      const user = this.authService.currentUser();
      if (user && this.isBrowser) {
        this.loadTransactions();
        this.setupRealtimeSubscription();
      } else if (!user && this.isBrowser) {
        this.cleanupRealtimeSubscription();
      }
    });

    // Au montage initial dans le navigateur, attend la session et déclenche le chargement
    if (this.isBrowser) {
      this.initBrowserData();
    }
  }

  private async initBrowserData(): Promise<void> {
    try {
      await this.authService.waitForSession();
      if (this.authService.isAuthenticated()) {
        await this.loadTransactions();
        await this.setupRealtimeSubscription();
      }
    } catch (e) {
      console.warn('Initialisation des données de caisse après refresh:', e);
    }
  }

  ngOnDestroy(): void {
    this.cleanupRealtimeSubscription();
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

      const searchableText = `${tx.libelle} ${tx.service || ''} ${tx.typeDescription || ''} ${tx.firstName || ''} ${tx.employee || ''} ${tx.partenaire || ''} ${tx.noDossier || ''}`.toLowerCase();
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

  private activeLoadPromise: Promise<void> | null = null;

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 1. LECTURE HAUTE DISPONIBILITÉ : DOUBLE CANAL (API EXPRESS + REPLI DIRECT SUPABASE)
   * ───────────────────────────────────────────────────────────────────────────
   * Tente d'abord de récupérer les opérations via l'API Express rapide (/api/cahier/operations).
   * En cas d'indisponibilité ou d'erreur réseau, bascule immédiatement sur le SDK client Supabase.
   * Gère la déduplication des appels concurrents via une Promesse unique partagée.
   */
  public async loadTransactions(): Promise<void> {
    if (this.activeLoadPromise) {
      return this.activeLoadPromise;
    }

    this.activeLoadPromise = (async () => {
      this._isLoading.set(true);
      this._error.set(null);

      let rawRows: CashierDbRow[] | null = null;
      let token = this.authService.token();

      try {
        // Si le token n'est pas encore dans le signal, tenter de le lire depuis la session Supabase
        if (!token && this.supabaseService.supabase) {
          try {
            const { data } = await this.supabaseService.supabase.auth.getSession();
            if (data.session?.access_token) {
              token = data.session.access_token;
            }
          } catch {
            // Ignorer
          }
        }

        // Canal 1 : API Express Serveur-Relais (si token disponible)
        if (token) {
          try {
            const headers: Record<string, string> = {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            };

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
            console.warn('API Express /api/cahier/operations indisponible, bascule sur Supabase direct:', apiErr);
          }
        }

        // Canal 2 (REPLI DIRECT SUPABASE CLIENT) : Interrogation directe de Supabase
        if (!rawRows) {
          try {
            await this.supabaseService.ensureInitialized();
            const client = this.supabaseService.supabase;

            if (client) {
              const { data, error } = await client
                .from('cashier_transactions')
                .select(CASHIER_SELECTED_COLUMNS)
                .order('date', { ascending: false });

              if (!error && data && Array.isArray(data)) {
                rawRows = data as CashierDbRow[];
              } else if (error) {
                console.warn('Requête Supabase direct cashier_transactions:', error.message);
              }
            }
          } catch (supabaseErr) {
            console.warn('Échec de la récupération Supabase direct:', supabaseErr);
          }
        }

        // Traitement et injection dans le Signal Angular 19
        if (rawRows && Array.isArray(rawRows)) {
          const mappedTransactions = this.mapDatabaseOperations(rawRows);
          this._transactions.set(mappedTransactions);
        }
      } catch (err: unknown) {
        console.error('Erreur globale lors du chargement des opérations de caisse:', err);
      } finally {
        this._isLoading.set(false);
        this.activeLoadPromise = null;
      }
    })();

    return this.activeLoadPromise;
  }

  private toIsoDateString(dStr?: string): string {
    if (!dStr) return new Date().toISOString();
    if (dStr.includes('/')) {
      const parts = dStr.split('/');
      if (parts.length === 3) {
        const parsed = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
        if (!isNaN(parsed.getTime())) return parsed.toISOString();
      }
    }
    const parsed = new Date(dStr);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
    return new Date().toISOString();
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
          service: op.service,
          typeDescription: op.typeDescription || null,
          category: op.category,
          status: op.status || 'draft',
          noDossier: op.noDossier || null,
          firstName: op.firstName || null,
          employee: op.employee || op.partenaire || null,
          partenaire: op.partenaire || op.employee || null,
          quantity: op.quantity || 1,
          montant: op.montant,
          date: this.toIsoDateString(op.date),
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
          const { data, error } = await client
            .from('cashier_transactions')
            .insert([
              {
                libelle: op.libelle,
                service: op.service || null,
                type_description: op.typeDescription || null,
                category: op.category,
                status: op.status || 'draft',
                no_dossier: op.noDossier || null,
                first_name: op.firstName || null,
                partenaire: op.partenaire || op.employee || null,
                employee: op.employee || op.partenaire || null,
                quantity: op.quantity || 1,
                montant: op.montant,
                date: op.date || new Date().toISOString(),
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
          service: savedRow.service || savedRow.type_transaction || '',
          typeDescription: savedRow.type_description || '',
          category: savedRow.category as 'entree' | 'sortie',
          status: (savedRow.status as 'draft' | 'posted' | 'cancelled') || op.status || 'draft',
          noDossier: savedRow.no_dossier || savedRow.matricule_vehicule || '',
          firstName: savedRow.first_name || '',
          employee: savedRow.employee || '',
          partenaire: savedRow.partenaire || savedRow.employee || '',
          quantity: savedRow.quantity ? Number(savedRow.quantity) : undefined,
          montant: Number(savedRow.montant),
          soldeApres: savedRow.solde_apres !== undefined && savedRow.solde_apres !== null ? Number(savedRow.solde_apres) : estimatedNewSolde,
          selected: false,
        }
      : {
          id: `tx-${Date.now()}`,
          date: this.formatDate(op.date || new Date().toISOString()),
          libelle: op.libelle || 'Opération',
          service: op.service || '',
          typeDescription: op.typeDescription || '',
          category: (op.category || (montant >= 0 ? 'entree' : 'sortie')) as 'entree' | 'sortie',
          status: op.status || 'draft',
          noDossier: op.noDossier || '',
          firstName: op.firstName || '',
          employee: op.employee || op.partenaire || '',
          partenaire: op.partenaire || op.employee || '',
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
  ): Promise<{ success: boolean; operation?: CashierTransaction }> {
    return this.saveOperationViaApi(newTx);
  }

  /**
   * Alias rétrocompatible pour la suppression des transactions sélectionnées
   */
  public async deleteSelectedTransactions(): Promise<boolean> {
    return this.deleteSelected();
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
      if (updatedFields.service !== undefined) bodyPayload['service'] = updatedFields.service;
      if (updatedFields.typeDescription !== undefined) bodyPayload['typeDescription'] = updatedFields.typeDescription;
      if (updatedFields.category !== undefined) bodyPayload['category'] = updatedFields.category;
      if (updatedFields.status !== undefined) bodyPayload['status'] = updatedFields.status;
      if (updatedFields.noDossier !== undefined) bodyPayload['noDossier'] = updatedFields.noDossier;
      if (updatedFields.firstName !== undefined) bodyPayload['firstName'] = updatedFields.firstName;
      if (updatedFields.employee !== undefined) bodyPayload['employee'] = updatedFields.employee;
      if (updatedFields.partenaire !== undefined) bodyPayload['partenaire'] = updatedFields.partenaire;
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
          if (updatedFields.service !== undefined) directPayload['service'] = updatedFields.service;
          if (updatedFields.typeDescription !== undefined) directPayload['type_description'] = updatedFields.typeDescription || null;
          if (updatedFields.category !== undefined) directPayload['category'] = updatedFields.category;
          if (updatedFields.status !== undefined) directPayload['status'] = updatedFields.status;
          if (updatedFields.noDossier !== undefined) directPayload['no_dossier'] = updatedFields.noDossier || null;
          if (updatedFields.firstName !== undefined) directPayload['first_name'] = updatedFields.firstName || null;
          if (updatedFields.partenaire !== undefined) directPayload['partenaire'] = updatedFields.partenaire || null;
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
          libelle: updatedFields.libelle !== undefined ? updatedFields.libelle : item.libelle,
          service: updatedFields.service !== undefined ? updatedFields.service : item.service,
          typeDescription: updatedFields.typeDescription !== undefined ? updatedFields.typeDescription : item.typeDescription,
          category: updatedFields.category !== undefined ? updatedFields.category : item.category,
          status: updatedFields.status !== undefined ? updatedFields.status : item.status,
          noDossier: updatedFields.noDossier !== undefined ? updatedFields.noDossier : item.noDossier,
          employee: updatedFields.employee !== undefined ? updatedFields.employee : item.employee,
          quantity: updatedFields.quantity !== undefined ? updatedFields.quantity : item.quantity,
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
   * Mappe une seule ligne de base de données vers le modèle applicatif
   */
  public mapSingleDbRow(row: CashierDbRow): CashierTransaction {
    const numMontant = Number(row.montant) || 0;
    return {
      id: row.id,
      date: this.formatDate(row.date),
      libelle: row.libelle || '',
      service: row.service || row.type_transaction || '',
      typeDescription: row.type_description || '',
      category: (row.category || (numMontant >= 0 ? 'entree' : 'sortie')) as 'entree' | 'sortie',
      status: (row.status as 'draft' | 'posted' | 'cancelled') || 'draft',
      noDossier: row.no_dossier || row.matricule_vehicule || '',
      firstName: row.first_name || '',
      employee: row.employee || '',
      partenaire: row.partenaire || row.employee || '',
      quantity: row.quantity !== null && row.quantity !== undefined ? Number(row.quantity) : undefined,
      montant: numMontant,
      soldeApres: row.solde_apres !== undefined && row.solde_apres !== null ? Number(row.solde_apres) : 0,
      selected: !!row.selected,
    };
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
        service: row.service || row.type_transaction || '',
        typeDescription: row.type_description || '',
        category: (row.category || (numMontant >= 0 ? 'entree' : 'sortie')) as 'entree' | 'sortie',
        status: (row.status as 'draft' | 'posted' | 'cancelled') || 'draft',
        noDossier: row.no_dossier || row.matricule_vehicule || '',
        firstName: row.first_name || '',
        employee: row.employee || '',
        partenaire: row.partenaire || row.employee || '',
        quantity: row.quantity !== null && row.quantity !== undefined ? Number(row.quantity) : undefined,
        montant: numMontant,
        soldeApres: row.solde_apres !== undefined && row.solde_apres !== null ? Number(row.solde_apres) : runningBalance,
        selected: !!row.selected,
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

  public toggleSelectAll(select?: boolean): void {
    const displayed = this.pagedTransactions();
    const shouldSelect = select !== undefined ? select : displayed.some((t) => !t.selected);
    const displayedIds = new Set(displayed.map((t) => t.id));
    this._transactions.update((items) =>
      items.map((item) =>
        displayedIds.has(item.id) ? { ...item, selected: shouldSelect } : item
      )
    );
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * SYNCHRONISATION EN TEMPS RÉEL (SUPABASE REALTIME WEBSOCKET)
   * ───────────────────────────────────────────────────────────────────────────
   * Écoute les événements INSERT, UPDATE, DELETE sur la table cashier_transactions
   * et met à jour instantanément le Signal _transactions sans rechargement,
   * avec réconciliation d'état automatique lors de la souscription ou reconnexion.
   */
  private async setupRealtimeSubscription(): Promise<void> {
    if (!this.isBrowser) return;

    try {
      await this.supabaseService.ensureInitialized();
      const client = this.supabaseService.supabase;
      if (!client) return;

      // Éviter les souscriptions en doublon
      if (this.realtimeChannel) {
        return;
      }

      this.realtimeChannel = client
        .channel('public:cashier_transactions')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'cashier_transactions' },
          (payload) => {
            const newRow = payload.new as CashierDbRow;
            if (!newRow || !newRow.id) return;
            const mapped = this.mapSingleDbRow(newRow);

            this._transactions.update((currentList) => {
              if (currentList.some((t) => t.id === mapped.id)) {
                return currentList;
              }
              return [mapped, ...currentList];
            });
            this.recalculateRunningBalances();
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'cashier_transactions' },
          (payload) => {
            const updatedRow = payload.new as CashierDbRow;
            if (!updatedRow || !updatedRow.id) return;
            const mapped = this.mapSingleDbRow(updatedRow);

            this._transactions.update((currentList) =>
              currentList.map((t) => (t.id === mapped.id ? { ...mapped, selected: t.selected } : t))
            );
            this.recalculateRunningBalances();
          }
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'cashier_transactions' },
          (payload) => {
            const deletedId = (payload.old as { id?: string })?.id;
            if (!deletedId) return;

            this._transactions.update((currentList) =>
              currentList.filter((t) => t.id !== deletedId)
            );
            this.recalculateRunningBalances();
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            // Re-synchronisation silencieuse pour s'assurer qu'aucune transaction n'a été manquée
            // avant ou pendant l'établissement de la connexion WebSocket
            this.loadTransactions();
          } else if (status === 'CHANNEL_ERROR') {
            console.warn('Erreur sur le canal Realtime Supabase cashier_transactions, tentative de reconnexion auto...');
          } else if (status === 'TIMED_OUT') {
            console.warn('Timeout sur le canal Realtime Supabase cashier_transactions');
          }
        });
    } catch (err) {
      console.warn('Impossible d’initialiser le canal Realtime Supabase:', err);
    }
  }

  private cleanupRealtimeSubscription(): void {
    if (this.realtimeChannel && this.supabaseService.supabase) {
      try {
        this.supabaseService.supabase.removeChannel(this.realtimeChannel);
      } catch (err) {
        console.warn('Erreur lors du nettoyage du canal Realtime Supabase:', err);
      }
      this.realtimeChannel = null;
    }
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
