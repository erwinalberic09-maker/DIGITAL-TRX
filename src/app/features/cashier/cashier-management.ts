import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
  ChartConfiguration,
} from 'chart.js';
import { CashierService } from '../../core/services/cashier.service';
import { AuthService } from '../../core/services/auth.service';
import {
  CashierTransaction,
  TransactionStatus,
  TransactionTypeCategory,
} from '../../core/models/cashier-transaction.model';
import { OdooDatepicker } from '../../shared/components/odoo-datepicker/odoo-datepicker';

// Enregistrement des composants nécessaires de Chart.js
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler
);

export interface CaisseTimelineData {
  labels: string[];
  balances: number[];
  descriptions: string[];
}

@Component({
  selector: 'app-cashier-management',
  imports: [ReactiveFormsModule, MatIconModule, OdooDatepicker],
  templateUrl: './cashier-management.html',
  styleUrl: './cashier-management.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class CashierManagement implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('caisseChartCanvas')
  private readonly caisseChartCanvas?: ElementRef<HTMLCanvasElement>;

  private readonly cashierService = inject(CashierService);
  private readonly authService = inject(AuthService);
  private readonly elementRef = inject(ElementRef);
  protected readonly Math = Math;
  private readonly platformId = inject(PLATFORM_ID);

  private chartInstance: Chart | null = null;

  // Permissions : Seuls admin et caissiere peuvent créer/modifier/supprimer
  public readonly canEdit = computed(() => {
    const role = this.authService.currentUser()?.role;
    return role === 'admin' || role === 'caissiere';
  });

  // Données réactives issues du service
  public readonly pagedTransactions = this.cashierService.pagedTransactions;
  public readonly allTransactions = this.cashierService.allTransactions;
  public readonly currentBalance = this.cashierService.currentBalance;
  public readonly totalCount = this.cashierService.totalCount;
  public readonly filterState = this.cashierService.filterState;
  public readonly isAllSelected = this.cashierService.isAllSelected;
  public readonly isLoading = this.cashierService.isLoading;
  public readonly error = this.cashierService.error;

  // Contrôles UI synchronisés avec le service
  public readonly isAddingRow = this.cashierService.isAddingRow;
  public readonly isSubmitting = signal<boolean>(false);
  public readonly isDeleting = signal<boolean>(false);
  public readonly isFilterDropdownOpen = signal<boolean>(false);
  public readonly searchControl = new FormControl<string>('', {
    nonNullable: true,
  });

  // Préparation réactive des données chronologiques pour Chart.js
  public readonly chartData = computed<CaisseTimelineData>(() => {
    const list = [...this.allTransactions()].sort((a, b) => {
      const dateA = new Date(a.date).getTime() || 0;
      const dateB = new Date(b.date).getTime() || 0;
      return dateA - dateB;
    });

    if (list.length === 0) {
      return {
        labels: ['Départ', 'Aujourd’hui'],
        balances: [0, 0],
        descriptions: ['Solde initial', 'Solde actuel'],
      };
    }

    let runningBalance = 0;
    const labels: string[] = [];
    const balances: number[] = [];
    const descriptions: string[] = [];

    for (const tx of list) {
      runningBalance += tx.montant;
      const parsedDate = new Date(tx.date);
      const formattedDate = !isNaN(parsedDate.getTime())
        ? parsedDate.toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'short',
          })
        : tx.date || 'Opération';

      labels.push(formattedDate);
      balances.push(runningBalance);
      descriptions.push(tx.libelle || tx.typeDescription || 'Mouvement de caisse');
    }

    return { labels, balances, descriptions };
  });

  // Nombre d'éléments sélectionnés
  public readonly selectedCount = computed(() => {
    return this.cashierService.allTransactions().filter((t) => t.selected).length;
  });

  // Pagination au format exact : "01-02 / 02" ou "00-00 / 00"
  public readonly paginationLabel = computed(() => {
    const total = this.totalCount();
    if (total === 0) return '00-00 / 00';
    const { pageIndex, pageSize } = this.filterState();
    const start = pageIndex * pageSize + 1;
    const end = Math.min((pageIndex + 1) * pageSize, total);

    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${pad(start)}-${pad(end)} / ${pad(total)}`;
  });

  public readonly canPrevPage = computed(() => this.filterState().pageIndex > 0);
  public readonly canNextPage = computed(() => {
    const { pageIndex, pageSize } = this.filterState();
    return (pageIndex + 1) * pageSize < this.totalCount();
  });

  // Formulaire de transaction réactif
  public readonly transactionForm = new FormGroup({
    date: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    libelle: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    service: new FormControl<'Opérations' | 'Administration' | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    typeDescription: new FormControl<string>('', { nonNullable: true }),
    category: new FormControl<TransactionTypeCategory | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    status: new FormControl<TransactionStatus | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    noDossier: new FormControl<string>('', { nonNullable: true }),
    employee: new FormControl<string>('', { nonNullable: true }),
    quantity: new FormControl<number | null>(null),
    montant: new FormControl<number | null>(null, {
      validators: [Validators.required, Validators.min(1)],
    }),
  });

  public readonly isOperationsType = signal<boolean>(false);

  // État du DatePicker Odoo pour l'ajout et l'édition
  public readonly isAddDatePickerOpen = signal<boolean>(false);
  public readonly isEditDatePickerOpen = signal<boolean>(false);

  // État et Formulaire d'édition par Double-Clic
  public readonly editingTxId = signal<string | null>(null);
  public readonly isEditingSubmitting = signal<boolean>(false);
  public readonly isEditOperationsType = signal<boolean>(false);

  public readonly editTransactionForm = new FormGroup({
    date: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    libelle: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    service: new FormControl<'Opérations' | 'Administration' | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    typeDescription: new FormControl<string>('', { nonNullable: true }),
    category: new FormControl<TransactionTypeCategory | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    status: new FormControl<TransactionStatus | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    noDossier: new FormControl<string>('', { nonNullable: true }),
    employee: new FormControl<string>('', { nonNullable: true }),
    quantity: new FormControl<number | null>(null),
    montant: new FormControl<number | null>(null, {
      validators: [Validators.required, Validators.min(1)],
    }),
  });

  constructor() {
    // Initialisation automatique du formulaire quand l'ajout est déclenché
    effect(() => {
      if (this.cashierService.isAddingRow()) {
        this.transactionForm.reset({
          date: '',
          libelle: '',
          service: '',
          typeDescription: '',
          category: '',
          status: '',
          noDossier: '',
          employee: '',
          quantity: null,
          montant: null,
        });
        this.isOperationsType.set(false);
        this.updateConditionalValidators(false);
      }
    });

    // Effet réactif mettant à jour Chart.js dès que les données du CashierService changent
    effect(() => {
      const data = this.chartData();
      if (this.chartInstance) {
        this.updateChartData(data);
      }
    });

    this.searchControl.valueChanges.subscribe((val) => {
      this.cashierService.setSearchQuery(val);
    });

    // Écoute dynamique du type de service pour activer la distribution analytique
    this.transactionForm.get('service')?.valueChanges.subscribe((type) => {
      const isOps = type === 'Opérations';
      this.isOperationsType.set(isOps);
      this.updateConditionalValidators(isOps);
    });

    this.editTransactionForm.get('service')?.valueChanges.subscribe((type) => {
      const isOps = type === 'Opérations';
      this.isEditOperationsType.set(isOps);
      this.updateEditConditionalValidators(isOps);
    });
  }

  private updateConditionalValidators(isOps: boolean): void {
    const noDossierCtrl = this.transactionForm.get('noDossier');
    const quantityCtrl = this.transactionForm.get('quantity');

    if (isOps) {
      noDossierCtrl?.setValidators([Validators.required, Validators.minLength(2)]);
      quantityCtrl?.setValidators([Validators.required, Validators.min(1)]);
    } else {
      noDossierCtrl?.clearValidators();
      quantityCtrl?.clearValidators();
    }
    noDossierCtrl?.updateValueAndValidity();
    quantityCtrl?.updateValueAndValidity();
  }

  private updateEditConditionalValidators(isOps: boolean): void {
    const noDossierCtrl = this.editTransactionForm.get('noDossier');
    const quantityCtrl = this.editTransactionForm.get('quantity');

    if (isOps) {
      noDossierCtrl?.setValidators([Validators.required, Validators.minLength(2)]);
      quantityCtrl?.setValidators([Validators.required, Validators.min(1)]);
    } else {
      noDossierCtrl?.clearValidators();
      quantityCtrl?.clearValidators();
    }
    noDossierCtrl?.updateValueAndValidity();
    quantityCtrl?.updateValueAndValidity();
  }

  public readonly todayFormatted = signal<string>('');
  public readonly todayIsoDate = signal<string>('');

  public ngOnInit(): void {
    this.cashierService.loadTransactions();
    const today = new Date();
    const isoDate = today.toISOString().split('T')[0];
    this.todayIsoDate.set(isoDate);

    this.todayFormatted.set(
      `${String(today.getDate()).padStart(2, '0')}/${String(
        today.getMonth() + 1
      ).padStart(2, '0')}/${today.getFullYear()}`
    );
  }

  public ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId) && this.caisseChartCanvas?.nativeElement) {
      this.initChart();
    }
  }

  public ngOnDestroy(): void {
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
  }

  // Initialisation du graphique natif Chart.js
  private initChart(): void {
    const canvas = this.caisseChartCanvas?.nativeElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = this.chartData();

    // Dégradé soigné sous la courbe (bleu Transimex)
    const gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(30, 58, 138, 0.22)');
    gradient.addColorStop(1, 'rgba(30, 58, 138, 0.0)');

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'Solde de caisse',
            data: data.balances,
            borderColor: '#1e3a8a',
            borderWidth: 2.5,
            backgroundColor: gradient,
            fill: true,
            tension: 0.35,
            pointBackgroundColor: '#1e3a8a',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1.5,
            pointRadius: 3,
            pointHoverRadius: 5.5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            top: 10,
            bottom: 6,
            left: 6,
            right: 12,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0f172a',
            titleColor: '#f8fafc',
            bodyColor: '#cbd5e1',
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (context) => {
                const val = Number(context.raw) || 0;
                const index = context.dataIndex;
                const desc = data.descriptions[index] ? ` (${data.descriptions[index]})` : '';
                return `Solde : ${this.formatCurrency(val)}${desc}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#64748b',
              font: { size: 10, family: 'sans-serif' },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 7,
            },
          },
          y: {
            border: { dash: [4, 4] },
            grid: {
              color: 'rgba(226, 232, 240, 0.6)',
            },
            ticks: {
              color: '#64748b',
              font: { size: 10, family: 'sans-serif' },
              callback: (value) => {
                const num = Number(value);
                if (Math.abs(num) >= 1_000_000) {
                  return `${(num / 1_000_000).toFixed(1)}M`;
                }
                if (Math.abs(num) >= 1_000) {
                  return `${(num / 1_000).toFixed(0)}k`;
                }
                return `${num}`;
              },
            },
          },
        },
      },
    };

    this.chartInstance = new Chart(ctx, config);
  }

  private updateChartData(data: CaisseTimelineData): void {
    if (!this.chartInstance) return;

    this.chartInstance.data.labels = data.labels;
    this.chartInstance.data.datasets[0].data = data.balances;
    this.chartInstance.update();
  }

  public refresh(): void {
    this.cashierService.loadTransactions();
  }

  public formatCurrency(amount: number): string {
    const formatted = Math.abs(amount)
      .toLocaleString('fr-FR')
      .replace(/\u202F/g, ' ');
    if (amount < 0) {
      return `-${formatted} FCFA`;
    }
    return `${formatted} FCFA`;
  }

  public formatSolde(amount: number): string {
    return amount.toLocaleString('fr-FR').replace(/\u202F/g, ' ');
  }

  public onToggleSelect(tx: CashierTransaction): void {
    this.cashierService.toggleSelectTransaction(tx.id);
  }

  public onToggleSelectAll(): void {
    this.cashierService.toggleSelectAll(!this.isAllSelected());
  }

  public async deleteSelectedTransactions(): Promise<void> {
    const count = this.selectedCount();
    if (count === 0) return;

    const confirmed = confirm(
      `Êtes-vous sûr de vouloir supprimer ${count} transaction(s) sélectionnée(s) ?`
    );
    if (!confirmed) return;

    this.isDeleting.set(true);
    await this.cashierService.deleteSelected();
    this.isDeleting.set(false);
  }

  public startAddInline(): void {
    // Règle Odoo : une seule ligne ouverte à la fois
    if (this.editingTxId()) {
      this.cancelInlineEdit();
    }

    this.transactionForm.reset({
      date: '',
      libelle: '',
      service: '',
      typeDescription: '',
      category: '',
      status: '',
      noDossier: '',
      employee: '',
      quantity: null,
      montant: null,
    });
    this.isOperationsType.set(false);
    this.updateConditionalValidators(false);
    this.cashierService.startAddTransaction();
  }

  public cancelAddInline(): void {
    this.cashierService.isAddingRow.set(false);
    this.transactionForm.reset();
  }

  public async submitInlineTransaction(): Promise<void> {
    if (this.isSubmitting()) return;

    if (this.transactionForm.invalid) {
      this.transactionForm.markAllAsTouched();
      return;
    }

    this.isSubmitting.set(true);
    try {
      const formValues = this.transactionForm.getRawValue();
      const rawMontant = Number(formValues.montant) || 0;
      const finalMontant =
        formValues.category === 'sortie' ? -Math.abs(rawMontant) : Math.abs(rawMontant);

      let formattedDate = this.todayFormatted();
      if (formValues.date) {
        const parts = formValues.date.split('-');
        if (parts.length === 3) {
          formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
        } else {
          formattedDate = formValues.date;
        }
      }

      const result = await this.cashierService.addTransaction({
        date: formattedDate,
        libelle: formValues.libelle,
        service: (formValues.service as 'Opérations' | 'Administration') || 'Administration',
        typeDescription: formValues.typeDescription || undefined,
        category: (formValues.category as TransactionTypeCategory) || 'sortie',
        status: (formValues.status as TransactionStatus) || 'draft',
        noDossier: formValues.noDossier || undefined,
        employee: formValues.employee || undefined,
        quantity: formValues.quantity !== null && formValues.quantity !== undefined ? Number(formValues.quantity) : undefined,
        montant: finalMontant,
      });

      if (result.success) {
        this.cancelAddInline();
      }
    } finally {
      this.isSubmitting.set(false);
    }
  }

  public startInlineEdit(tx: CashierTransaction): void {
    if (!this.canEdit()) return;

    // Règle Odoo : fermer toute ligne d'ajout ou d'édition en cours
    if (this.isAddingRow()) {
      this.cancelAddInline();
    }
    if (this.editingTxId()) {
      this.cancelInlineEdit();
    }

    let isoDate = this.todayIsoDate();
    if (tx.date) {
      if (tx.date.includes('/')) {
        const parts = tx.date.split('/');
        if (parts.length === 3) {
          isoDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
      } else if (tx.date.includes('-')) {
        isoDate = tx.date;
      }
    }

    const isOps = tx.service === 'Opérations';
    this.isEditOperationsType.set(isOps);

    this.editTransactionForm.patchValue({
      date: isoDate,
      libelle: tx.libelle || '',
      service: (tx.service as 'Opérations' | 'Administration') || '',
      typeDescription: tx.typeDescription || '',
      category: tx.category || 'sortie',
      status: tx.status || 'draft',
      noDossier: tx.noDossier || '',
      employee: tx.employee || '',
      quantity: tx.quantity !== undefined && tx.quantity !== null ? tx.quantity : null,
      montant: tx.montant !== undefined && tx.montant !== null ? Math.abs(tx.montant) : null,
    });

    this.updateEditConditionalValidators(isOps);
    this.editingTxId.set(tx.id);
  }

  /**
   * Fermeture automatique Odoo quand l'utilisateur clique hors de la ligne ouverte ou du tableau
   */
  public onDocumentClick(event: MouseEvent): void {
    if (this.isSubmitting() || this.isEditingSubmitting()) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Si on a cliqué sur le bouton "Nouveau" du bandeau ou dans un popover de datepicker, ne pas fermer la ligne
    if (target.closest('#cashier-new-btn') || target.closest('app-odoo-datepicker') || target.closest('.odoo-datepicker-popover')) {
      return;
    }

    // 1. Si la ligne d'ajout est ouverte et qu'on clique en dehors
    if (this.isAddingRow()) {
      const addRowEl = this.elementRef.nativeElement.querySelector('#inline-add-row');
      if (addRowEl && !addRowEl.contains(target)) {
        // Sauvegarder si valide ou fermer
        const libelleVal = this.transactionForm.get('libelle')?.value?.trim();
        const montantVal = this.transactionForm.get('montant')?.value;
        if (libelleVal && montantVal) {
          this.submitInlineTransaction();
        } else {
          this.cancelAddInline();
        }
      }
    }

    // 2. Si une ligne existante est en édition et qu'on clique en dehors
    const activeEditId = this.editingTxId();
    if (activeEditId) {
      const editRowEl = this.elementRef.nativeElement.querySelector(`#inline-edit-row-${activeEditId}`);
      if (editRowEl && !editRowEl.contains(target)) {
        const libelleVal = this.editTransactionForm.get('libelle')?.value?.trim();
        if (libelleVal) {
          this.submitInlineEdit();
        } else {
          this.cancelInlineEdit();
        }
      }
    }
  }

  public onAddKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.isAddDatePickerOpen.set(false);
      this.submitInlineTransaction();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.isAddDatePickerOpen.set(false);
      this.cancelAddInline();
    }
  }

  public openAddDatePicker(event?: Event): void {
    if (event) event.stopPropagation();
    this.isAddDatePickerOpen.set(true);
    this.isEditDatePickerOpen.set(false);
  }

  public closeAddDatePicker(): void {
    this.isAddDatePickerOpen.set(false);
  }

  public onAddDateSelected(isoDate: string): void {
    this.transactionForm.patchValue({ date: isoDate });
    this.isAddDatePickerOpen.set(false);
  }

  public openEditDatePicker(event?: Event): void {
    if (event) event.stopPropagation();
    this.isEditDatePickerOpen.set(true);
    this.isAddDatePickerOpen.set(false);
  }

  public closeEditDatePicker(): void {
    this.isEditDatePickerOpen.set(false);
  }

  public onEditDateSelected(isoDate: string): void {
    this.editTransactionForm.patchValue({ date: isoDate });
    this.isEditDatePickerOpen.set(false);
  }

  public cancelInlineEdit(): void {
    this.editingTxId.set(null);
    this.isEditDatePickerOpen.set(false);
    this.editTransactionForm.reset();
  }

  public async submitInlineEdit(): Promise<void> {
    if (this.isEditingSubmitting()) return;
    const activeId = this.editingTxId();
    if (!activeId) return;

    const formValues = this.editTransactionForm.getRawValue();
    const libelle = formValues.libelle?.trim();
    if (!libelle) {
      this.editTransactionForm.get('libelle')?.markAsTouched();
      return;
    }

    this.isEditingSubmitting.set(true);
    try {
      const rawMontant = Number(formValues.montant) || 0;
      const finalMontant =
        formValues.category === 'sortie' ? -Math.abs(rawMontant) : Math.abs(rawMontant);

      let formattedDate = this.todayFormatted();
      if (formValues.date) {
        if (formValues.date.includes('-')) {
          const parts = formValues.date.split('-');
          if (parts.length === 3) {
            formattedDate = `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
          } else {
            formattedDate = formValues.date;
          }
        } else {
          formattedDate = formValues.date;
        }
      }

      const result = await this.cashierService.updateTransaction(activeId, {
        date: formattedDate,
        libelle: libelle,
        service: (formValues.service as 'Opérations' | 'Administration') || '',
        typeDescription: formValues.typeDescription || undefined,
        category: (formValues.category as TransactionTypeCategory) || 'sortie',
        status: (formValues.status as TransactionStatus) || 'draft',
        noDossier: formValues.noDossier || undefined,
        employee: formValues.employee || undefined,
        quantity: formValues.quantity !== null && formValues.quantity !== undefined ? Number(formValues.quantity) : undefined,
        montant: finalMontant,
      });

      if (result.success) {
        this.cancelInlineEdit();
      }
    } finally {
      this.isEditingSubmitting.set(false);
    }
  }

  public onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.submitInlineEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelInlineEdit();
    }
  }

  /**
   * Génère la référence de pièce comptable séquentielle au format Odoo ERP (ex: CSH1/2026/00001)
   */
  public getOdooSequence(tx: CashierTransaction, index: number): string {
    const year = tx.date?.includes('/') ? tx.date.split('/')[2] || '2026' : (tx.date?.includes('-') ? tx.date.split('-')[0] : '2026');
    const cleanId = tx.id.replace(/\D/g, '');
    const seqNum = cleanId ? String(parseInt(cleanId.slice(-4), 10) || (index + 1)) : String(index + 1);
    return `CSH1/${year}/${seqNum.padStart(5, '0')}`;
  }

  /**
   * Formate la date au style compact Odoo (ex: 2 sept.)
   */
  public formatOdooDate(dateStr: string): string {
    if (!dateStr) return '';
    try {
      let d: Date;
      if (dateStr.includes('/')) {
        const [day, month, year] = dateStr.split('/');
        d = new Date(Number(year), Number(month) - 1, Number(day));
      } else {
        d = new Date(dateStr);
      }
      if (isNaN(d.getTime())) return dateStr;
      const formatted = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      return formatted.endsWith('.') ? formatted : `${formatted}.`;
    } catch {
      return dateStr;
    }
  }

  /**
   * Calcule le solde prévisionnel lors de la saisie d'une nouvelle ligne
   */
  public getEstimatedBalance(): string {
    const rawVal = this.transactionForm.get('montant')?.value;
    const num = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal || 0).replace(/[^\d.-]/g, '')) || 0;
    const cat = this.transactionForm.get('category')?.value;
    const diff = cat === 'sortie' ? -Math.abs(num) : Math.abs(num);
    return this.formatCurrency(this.currentBalance() + diff);
  }

  public trackByTxId(_index: number, tx: CashierTransaction): string {
    return tx.id;
  }
}

export { CashierManagement as CashierManagementComponent };
