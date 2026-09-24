import { Injectable, computed, inject, signal, effect, PLATFORM_ID, OnDestroy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  CashierFilterState,
  CashierTransaction,
} from '../models/cashier-transaction.model';
import {
  findDuplicatePieceComptable,
  findDuplicateTransaction,
  formatIsoToDisplayDate,
  generateTransactionFingerprint,
  normalizePieceComptable,
  toStandardIsoDateString,
} from '../utils/cashier-duplicate.util';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { ExportService } from './export.service';
import { NotificationService } from './notification.service';
import { ParsedImportRow } from './import.service';

export interface CashierDbRow {
  id: string;
  piece_comptable?: string | null;
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
  created_by?: string | null;
  employee_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

@Injectable({
  providedIn: 'root',
})
export class CashierService implements OnDestroy {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly exportService = inject(ExportService);
  private readonly notificationService = inject(NotificationService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // Liste des transactions en Signal réactif
  private readonly _transactions = signal<CashierTransaction[]>([]);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private errorTimeout: ReturnType<typeof setTimeout> | null = null;
  private realtimeChannel: ReturnType<NonNullable<SupabaseService['supabase']>['channel']> | null = null;

  public setError(message: string | null, notify = true): void {
    if (this.errorTimeout) {
      clearTimeout(this.errorTimeout);
      this.errorTimeout = null;
    }
    this._error.set(message);

    if (message && notify) {
      const lower = message.toLowerCase();
      if (lower.includes('doublon') || lower.includes('pièce comptable') || lower.includes('identique') || lower.includes('déjà attribué') || lower.includes('déjà enregistré')) {
        this.notificationService.warning(message, 'Doublon détecté');
      } else {
        this.notificationService.error(message, 'Erreur');
      }
    }
  }

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

  // Filtres et pagination (plancher de 80 lignes minimum par page)
  private readonly _filterState = signal<CashierFilterState>({
    searchQuery: '',
    categoryFilter: 'all',
    pageIndex: 0,
    pageSize: 80,
  });

  // Signal pour piloter l'ouverture de la ligne d'ajout inline depuis le Layout
  public readonly isAddingRow = signal<boolean>(false);

  // Signal pour piloter l'ouverture de la boîte modale d'importation Excel / CSV
  public readonly isImportModalOpen = signal<boolean>(false);

  public openImportModal(): void {
    this.isImportModalOpen.set(true);
  }

  public closeImportModal(): void {
    this.isImportModalOpen.set(false);
  }

  // Signal calculé pour la prochaine référence de pièce comptable prévisionnelle (ex: CSH1/2026/00004)
  public readonly nextPieceComptable = computed<string>(() => {
    const list = this._transactions();
    const currentYear = new Date().getFullYear() || 2026;
    const prefix = `CSH1/${currentYear}/`;
    let maxSeq = 0;

    for (const t of list) {
      const piece = normalizePieceComptable(t.pieceComptable);
      if (piece && piece.startsWith(prefix)) {
        const seqStr = piece.substring(prefix.length);
        const seqNum = parseInt(seqStr, 10);
        if (!isNaN(seqNum) && seqNum > maxSeq) {
          maxSeq = seqNum;
        }
      }
    }

    const nextNum = maxSeq > 0 ? maxSeq + 1 : list.length + 1;
    return `${prefix}${String(nextNum).padStart(5, '0')}`;
  });

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

  public static readonly DEFAULT_OPERATIONS_LIMIT = 1000;

  private activeLoadPromise: Promise<void> | null = null;

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 1. LECTURE CENTRALISÉE VIA L'API EXPRESS
   * ───────────────────────────────────────────────────────────────────────────
   * Tente d'abord de récupérer les opérations via l'API Express rapide (/api/cahier/operations).
   * En cas d'indisponibilité ou d'erreur réseau, l'opération échoue sans contourner les contrôles serveur.
   * Gère la déduplication des appels concurrents via une Promesse unique partagée.
   * Borne systématiquement le volume à `limit` (1000 par défaut) sur les deux canaux
   * afin de protéger l'onglet contre toute surcharge mémoire en situation dégradée.
   */
  public async loadTransactions(limit: number = CashierService.DEFAULT_OPERATIONS_LIMIT): Promise<void> {
    if (this.activeLoadPromise) {
      return this.activeLoadPromise;
    }

    this.activeLoadPromise = (async () => {
      this._isLoading.set(true);
      this._error.set(null);

      let rawRows: CashierDbRow[] | null = null;
      let token = this.authService.token();

      if (!token) {
        await this.authService.waitForSession();
        token = this.authService.token();
      }

      if (token) {
        try {
          const res = await fetch(`/api/caisse/operations?limit=${limit}`, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          if (res.ok) {
            const json = await res.json();
            if (json && Array.isArray(json.operations)) {
              rawRows = json.operations;
            }
          }
        } catch (fetchErr) {
          console.warn('Endpoint API indisponible:', fetchErr);
        }
      }

      if (rawRows && rawRows.length >= 0) {
        const transactions = this.mapDbRowsToTransactions(rawRows);
        this._transactions.set(transactions);
        this.recalculateRunningBalances();
        this._isLoading.set(false);
        return;
      }

      this._transactions.set([]);
      this._isLoading.set(false);
    })().finally(() => {
      this.activeLoadPromise = null;
    });

    return this.activeLoadPromise;
  }

  private mapDbRowsToTransactions(rows: CashierDbRow[]): CashierTransaction[] {
    return rows.map((r) => ({
      id: r.id,
      pieceComptable: r.piece_comptable || '',
      date: r.date,
      displayDate: this.formatDate(r.date),
      libelle: r.libelle,
      service: r.service || '',
      typeTransaction: r.type_transaction || '',
      typeDescription: r.type_description || '',
      category: r.category,
      status: r.status,
      noDossier: r.no_dossier || '',
      matriculeVehicule: r.matricule_vehicule || '',
      firstName: r.first_name || '',
      partenaire: r.partenaire || '',
      employee: r.employee || '',
      quantity: r.quantity ?? 1,
      montant: r.montant,
      soldeApres: r.solde_apres ?? 0,
      selected: false,
      createdBy: r.created_by || '',
      employeeId: r.employee_id || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  private recalculateRunningBalances(): void {
    const list = [...this._transactions()];
    let running = 0;
    for (let i = 0; i < list.length; i++) {
      running += list[i].montant;
      list[i].soldeApres = running;
    }
    this._transactions.set(list);
  }

  public setSearchQuery(query: string): void {
    this._filterState.update((state) => ({
      ...state,
      searchQuery: query,
      pageIndex: 0,
    }));
  }

  public setCategoryFilter(category: CashierFilterState['categoryFilter']): void {
    this._filterState.update((state) => ({
      ...state,
      categoryFilter: category,
      pageIndex: 0,
    }));
  }

  public setPage(pageIndex: number): void {
    const maxPage = Math.max(0, Math.ceil(this.totalCount() / this._filterState().pageSize) - 1);
    const validPage = Math.min(Math.max(0, pageIndex), maxPage);
    this._filterState.update((state) => ({ ...state, pageIndex: validPage }));
  }

  public nextPage(): void {
    if (this.hasNextPage()) {
      this._filterState.update((state) => ({ ...state, pageIndex: state.pageIndex + 1 }));
    }
  }

  public prevPage(): void {
    if (this.hasPrevPage()) {
      this._filterState.update((state) => ({ ...state, pageIndex: state.pageIndex - 1 }));
    }
  }

  public setPageSize(pageSize: number): void {
    this._filterState.update((state) => ({
      ...state,
      pageSize,
      pageIndex: 0,
    }));
  }

  public toggleSelectAll(selected: boolean): void {
    const pagedIds = new Set(this.pagedTransactions().map((t) => t.id));
    this._transactions.update((list) =>
      list.map((tx) => (pagedIds.has(tx.id) ? { ...tx, selected } : tx))
    );
  }

  public toggleSelectTransaction(id: string, selected?: boolean): void {
    this._transactions.update((list) =>
      list.map((tx) =>
        tx.id === id ? { ...tx, selected: selected !== undefined ? selected : !tx.selected } : tx
      )
    );
  }

  public async addTransaction(raw: Partial<CashierTransaction>): Promise<{ success: boolean; data?: CashierTransaction | null; error?: string }> {
    const res = await this.createTransaction(raw);
    if (res) {
      return { success: true, data: res };
    }
    return { success: false, error: this._error() || 'Erreur lors de la création de la transaction' };
  }

  public startAddTransaction(): void {
    this.isAddingRow.set(true);
  }

  public stopAddTransaction(): void {
    this.isAddingRow.set(false);
  }

  public async createTransaction(raw: Partial<CashierTransaction>): Promise<CashierTransaction | null> {
    this.setError(null, false);
    const token = this.authService.token();
    if (!token) {
      this.setError('Authentification requise');
      return null;
    }

    try {
      const res = await fetch('/api/caisse/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          date: raw.date || toStandardIsoDateString(new Date().toISOString()),
          libelle: raw.libelle || '',
          service: raw.service || '',
          type_transaction: raw.typeTransaction || '',
          type_description: raw.typeDescription || '',
          category: raw.category || 'entree',
          status: raw.status || 'posted',
          no_dossier: raw.noDossier || '',
          matricule_vehicule: raw.matriculeVehicule || '',
          first_name: raw.firstName || '',
          partenaire: raw.partenaire || '',
          employee: raw.employee || '',
          quantity: raw.quantity ?? 1,
          montant: raw.montant || 0,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.setError(err.error || 'Erreur lors de la création');
        return null;
      }

      const created = await res.json();
      await this.loadTransactions();
      this.stopAddTransaction();
      this.notificationService.success('Opération enregistrée avec succès');
      return created;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Erreur réseau';
      this.setError(msg);
      return null;
    }
  }

  public async updateTransaction(id: string, updates: Partial<CashierTransaction>): Promise<boolean> {
    this.setError(null, false);
    const token = this.authService.token();
    if (!token) {
      this.setError('Authentification requise');
      return false;
    }

    try {
      const payload: Record<string, unknown> = {};
      if (updates.date !== undefined) payload['date'] = updates.date;
      if (updates.libelle !== undefined) payload['libelle'] = updates.libelle;
      if (updates.service !== undefined) payload['service'] = updates.service;
      if (updates.typeTransaction !== undefined) payload['type_transaction'] = updates.typeTransaction;
      if (updates.typeDescription !== undefined) payload['type_description'] = updates.typeDescription;
      if (updates.category !== undefined) payload['category'] = updates.category;
      if (updates.status !== undefined) payload['status'] = updates.status;
      if (updates.noDossier !== undefined) payload['no_dossier'] = updates.noDossier;
      if (updates.matriculeVehicule !== undefined) payload['matricule_vehicule'] = updates.matriculeVehicule;
      if (updates.firstName !== undefined) payload['first_name'] = updates.firstName;
      if (updates.partenaire !== undefined) payload['partenaire'] = updates.partenaire;
      if (updates.employee !== undefined) payload['employee'] = updates.employee;
      if (updates.quantity !== undefined) payload['quantity'] = updates.quantity;
      if (updates.montant !== undefined) payload['montant'] = updates.montant;

      const res = await fetch(`/api/caisse/operations/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this.setError(err.error || 'Erreur lors de la mise à jour');
        return false;
      }

      await this.loadTransactions();
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Erreur réseau';
      this.setError(msg);
      return false;
    }
  }

  public async deleteSelected(): Promise<boolean> {
    const selected = this._transactions().filter((t) => t.selected);
    if (selected.length === 0) return true;

    const token = this.authService.token();
    if (!token) return false;

    try {
      for (const tx of selected) {
        await fetch(`/api/caisse/operations/${tx.id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      }
      await this.loadTransactions();
      this.notificationService.success(`${selected.length} opération(s) supprimée(s)`);
      return true;
    } catch (e) {
      console.warn('Erreur suppression sélection:', e);
      return false;
    }
  }

  public async duplicateSelected(): Promise<void> {
    const selected = this._transactions().filter((t) => t.selected);
    if (selected.length === 0) return;

    const token = this.authService.token();
    if (!token) return;

    for (const tx of selected) {
      await fetch('/api/caisse/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          date: toStandardIsoDateString(new Date().toISOString()),
          libelle: `${tx.libelle} (Copie)`,
          service: tx.service,
          type_transaction: tx.typeTransaction,
          type_description: tx.typeDescription,
          category: tx.category,
          status: 'draft',
          no_dossier: tx.noDossier,
          matricule_vehicule: tx.matriculeVehicule,
          first_name: tx.firstName,
          partenaire: tx.partenaire,
          employee: tx.employee,
          quantity: tx.quantity,
          montant: tx.montant,
        }),
      });
    }

    await this.loadTransactions();
    this.notificationService.success(`${selected.length} opération(s) dupliquée(s)`);
  }

  public async resetSelectedToDraft(): Promise<void> {
    const selected = this._transactions().filter((t) => t.selected);
    for (const tx of selected) {
      await this.updateTransaction(tx.id, { status: 'draft' });
    }
    this.notificationService.info(`${selected.length} opération(s) remise(s) en brouillon`);
  }

  public exportTransactions(selectedOnly = false): void {
    const list = selectedOnly
      ? this._transactions().filter((t) => t.selected)
      : this.filteredTransactions();
    this.exportService.exportToCsv(list, `operations-caisse-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  public exportSpreadsheet(): void {
    const list = this.filteredTransactions();
    this.exportService.exportToSpreadsheet(list, `journal-caisse-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  public downloadAttachments(): void {
    this.notificationService.info('Aucune pièce jointe disponible pour cette sélection');
  }

  public async importTransactions(rows: ParsedImportRow[]): Promise<{ insertedCount: number; duplicateCount: number; errors: string[] }> {
    const token = this.authService.token();
    if (!token) {
      return { insertedCount: 0, duplicateCount: 0, errors: ['Non authentifié'] };
    }

    try {
      const res = await fetch('/api/caisse/operations/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rows }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return {
          insertedCount: 0,
          duplicateCount: 0,
          errors: [err.error || 'Erreur lors de l’importation'],
        };
      }

      const data = await res.json();
      await this.loadTransactions();
      return {
        insertedCount: data.insertedCount || 0,
        duplicateCount: data.duplicateCount || 0,
        errors: data.errors || [],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Erreur réseau';
      return { insertedCount: 0, duplicateCount: 0, errors: [msg] };
    }
  }

  private setupRealtimeSubscription(): void {
    if (!this.supabaseService.isConfigured() || !this.supabaseService.supabase) {
      return;
    }

    this.cleanupRealtimeSubscription();

    try {
      this.realtimeChannel = this.supabaseService.supabase
        .channel('cashier_transactions_realtime')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'cashier_transactions' },
          (payload) => {
            const newRow = payload.new as CashierDbRow;
            if (!newRow || !newRow.id) return;

            this._transactions.update((currentList) => {
              if (currentList.some((t) => t.id === newRow.id)) {
                return currentList;
              }
              const tx = this.mapDbRowsToTransactions([newRow])[0];
              return [...currentList, tx];
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

            const updatedTx = this.mapDbRowsToTransactions([updatedRow])[0];
            this._transactions.update((currentList) =>
              currentList.map((t) => (t.id === updatedTx.id ? updatedTx : t))
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
            this.loadTransactions();
          } else if (status === 'CHANNEL_ERROR') {
            console.warn('Erreur sur le canal Realtime Supabase cashier_transactions');
          } else if (status === 'TIMED_OUT') {
            this.loadTransactions();
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

  public clearError(): void {
    if (this.errorTimeout) {
      clearTimeout(this.errorTimeout);
      this.errorTimeout = null;
    }
    this._error.set(null);
  }

  private formatDate(dateStr: string): string {
    return formatIsoToDisplayDate(dateStr);
  }
}
