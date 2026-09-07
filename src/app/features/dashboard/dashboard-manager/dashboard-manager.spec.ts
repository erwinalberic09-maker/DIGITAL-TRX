import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { DashboardManager } from './dashboard-manager';
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';
import { UserProfile } from '../../../core/models/auth.model';
import { CashierTransaction } from '../../../core/models/cashier-transaction.model';

describe('DashboardManager', () => {
  let component: DashboardManager;
  let fixture: ComponentFixture<DashboardManager>;

  const mockManagerUser: UserProfile = {
    id: 'manager-1',
    email: 'manager@transimex.cm',
    firstName: 'Paul',
    lastName: 'Ewane',
    role: 'manager',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const mockTransactions: CashierTransaction[] = [
    {
      id: 'tx-1',
      date: '2026-03-01',
      libelle: 'Approvisionnement caisse',
      typeTransaction: 'Espèces',
      typeDescription: 'Dotation',
      category: 'entree',
      firstName: 'Jean',
      quantity: 1,
      montant: 500000,
    },
    {
      id: 'tx-2',
      date: '2026-03-02',
      libelle: 'Carburant transport',
      typeTransaction: 'Gasoil',
      typeDescription: 'Camion 01',
      category: 'sortie',
      firstName: 'Paul',
      quantity: 1,
      montant: -50000,
    },
  ];

  const currentUserSignal = signal<UserProfile | null>(mockManagerUser);
  const transactionsSignal = signal<CashierTransaction[]>(mockTransactions);
  const balanceSignal = signal<number>(450000);

  const authServiceMock = {
    currentUser: currentUserSignal,
  };

  const cashierServiceMock = {
    allTransactions: transactionsSignal,
    currentBalance: balanceSignal,
    loadTransactions: () => Promise.resolve(),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardManager],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
        { provide: CashierService, useValue: cashierServiceMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardManager);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create dashboard manager component', () => {
    expect(component).toBeTruthy();
  });

  it('should format currency correctly in FCFA', () => {
    expect(component.formatCurrency(450000)).toContain('450');
    expect(component.formatCurrency(450000)).toContain('FCFA');
  });

  it('should compute chart timeline data correctly from transactions', () => {
    const data = component.chartData();
    expect(data.labels.length).toBe(2);
    expect(data.balances.length).toBe(2);
    expect(data.balances[0]).toBe(500000);
    expect(data.balances[1]).toBe(450000);
    expect(data.descriptions[0]).toBe('Approvisionnement caisse');
  });

  it('should handle empty transactions gracefully with default chart data', () => {
    transactionsSignal.set([]);
    fixture.detectChanges();

    const data = component.chartData();
    expect(data.labels).toEqual(['Départ', 'Aujourd’hui']);
    expect(data.balances).toEqual([0, 0]);

    // Restore transactions
    transactionsSignal.set(mockTransactions);
  });

  it('should clean up chart instance on destroy without throwing', () => {
    expect(() => component.ngOnDestroy()).not.toThrow();
  });
});



