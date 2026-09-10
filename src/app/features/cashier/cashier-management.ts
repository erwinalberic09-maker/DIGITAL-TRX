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
import { CommonModule } from '@angular/common';
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
  TransactionTypeCategory,
} from '../../core/models/cashier-transaction.model';

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
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './cashier-management.html',
  styleUrl: './cashier-management.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CashierManagement implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('caisseChartCanvas')
  private readonly caisseChartCanvas?: ElementRef<HTMLCanvasElement>;

  private readonly cashierService = inject(CashierService);
  private readonly authService = inject(AuthService);
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
    typeTransaction: new FormControl<'Opérations' | 'Administration'>('Administration', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    typeDescription: new FormControl<string>('', { nonNullable: true }),
    category: new FormControl<TransactionTypeCategory>('sortie', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    matriculeVehicule: new FormControl<string>('', { nonNullable: true }),
    employee: new FormControl<string>('', { nonNullable: true }),
    quantity: new FormControl<number | null>(null),
    montant: new FormControl<number | null>(null, {
      validators: [Validators.required, Validators.min(1)],
    }),
  });

  public readonly isOperationsType = signal<boolean>(false);

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
    typeTransaction: new FormControl<'Opérations' | 'Administration'>('Administration', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    typeDescription: new FormControl<string>('', { nonNullable: true }),
    category: new FormControl<TransactionTypeCategory>('sortie', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    matriculeVehicule: new FormControl<string>('', { nonNullable: true }),
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
        const today = new Date();
        const isoDate = today.toISOString().split('T')[0];
        this.transactionForm.reset({
          date: isoDate,
          libelle: '',
          typeTransaction: 'Administration',
          typeDescription: '',
          category: 'sortie',
          matriculeVehicule: '',
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

    // Écoute dynamique du type de transaction pour activer la distribution analytique
    this.transactionForm.get('typeTransaction')?.valueChanges.subscribe((type) => {
      const isOps = type === 'Opérations';
      this.isOperationsType.set(isOps);
      this.updateConditionalValidators(isOps);
    });

    this.editTransactionForm.get('typeTransaction')?.valueChanges.subscribe((type) => {
      const isOps = type === 'Opérations';
      this.isEditOperationsType.set(isOps);
      this.updateEditConditionalValidators(isOps);
    });
  }

  private updateConditionalValidators(isOps: boolean): void {
    const matriculeCtrl = this.transactionForm.get('matriculeVehicule');
    const quantityCtrl = this.transactionForm.get('quantity');

    if (isOps) {
      matriculeCtrl?.setValidators([Validators.required, Validators.minLength(2)]);
      quantityCtrl?.setValidators([Validators.required, Validators.min(1)]);
    } else {
      matriculeCtrl?.clearValidators();
      quantityCtrl?.clearValidators();
    }
    matriculeCtrl?.updateValueAndValidity();
    quantityCtrl?.updateValueAndValidity();
  }

  private updateEditConditionalValidators(isOps: boolean): void {
    const matriculeCtrl = this.editTransactionForm.get('matriculeVehicule');
    const quantityCtrl = this.editTransactionForm.get('quantity');

    if (isOps) {
      matriculeCtrl?.setValidators([Validators.required, Validators.minLength(2)]);
      quantityCtrl?.setValidators([Validators.required, Validators.min(1)]);
    } else {
      matriculeCtrl?.clearValidators();
      quantityCtrl?.clearValidators();
    }
    matriculeCtrl?.updateValueAndValidity();
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
    const today = new Date();
    const isoDate = today.toISOString().split('T')[0];
    this.transactionForm.reset({
      date: isoDate,
      libelle: '',
      typeTransaction: 'Administration',
      typeDescription: '',
      category: 'sortie',
      matriculeVehicule: '',
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
    if (this.transactionForm.invalid) {
      this.transactionForm.markAllAsTouched();
      return;
    }

    this.isSubmitting.set(true);
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
      typeTransaction: formValues.typeTransaction,
      typeDescription: formValues.typeDescription || undefined,
      category: formValues.category,
      matriculeVehicule: formValues.matriculeVehicule || undefined,
      employee: formValues.employee || undefined,
      quantity: formValues.quantity !== null && formValues.quantity !== undefined ? Number(formValues.quantity) : undefined,
      montant: finalMontant,
    });

    this.isSubmitting.set(false);
    if (result.success) {
      this.cancelAddInline();
    }
  }

  public startInlineEdit(tx: CashierTransaction): void {
    if (!this.canEdit()) return;

    let isoDate = this.todayIsoDate();
    if (tx.date) {
      const parts = tx.date.split('/');
      if (parts.length === 3) {
        isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
    }

    const isOps = tx.typeTransaction === 'Opérations';
    this.isEditOperationsType.set(isOps);

    this.editTransactionForm.patchValue({
      date: isoDate,
      libelle: tx.libelle,
      typeTransaction: isOps ? 'Opérations' : 'Administration',
      typeDescription: tx.typeDescription || '',
      category: tx.category,
      matriculeVehicule: tx.matriculeVehicule || '',
      employee: tx.employee || '',
      quantity: tx.quantity !== undefined ? tx.quantity : null,
      montant: Math.abs(tx.montant),
    });

    this.updateEditConditionalValidators(isOps);
    this.editingTxId.set(tx.id);
  }

  public cancelInlineEdit(): void {
    this.editingTxId.set(null);
    this.editTransactionForm.reset();
  }

  public async submitInlineEdit(): Promise<void> {
    const activeId = this.editingTxId();
    if (!activeId) return;

    if (this.editTransactionForm.invalid) {
      this.editTransactionForm.markAllAsTouched();
      return;
    }

    this.isEditingSubmitting.set(true);
    const formValues = this.editTransactionForm.getRawValue();
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

    const result = await this.cashierService.updateTransaction(activeId, {
      date: formattedDate,
      libelle: formValues.libelle,
      typeTransaction: formValues.typeTransaction,
      typeDescription: formValues.typeDescription || undefined,
      category: formValues.category,
      matriculeVehicule: formValues.matriculeVehicule || undefined,
      employee: formValues.employee || undefined,
      quantity: formValues.quantity !== null && formValues.quantity !== undefined ? Number(formValues.quantity) : undefined,
      montant: finalMontant,
    });

    this.isEditingSubmitting.set(false);
    if (result.success) {
      this.cancelInlineEdit();
    }
  }

  public onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submitInlineEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelInlineEdit();
    }
  }

  public trackByTxId(_index: number, tx: CashierTransaction): string {
    return tx.id;
  }
}

export { CashierManagement as CashierManagementComponent };
