import { TestBed } from '@angular/core/testing';
import { CashierService } from './cashier.service';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('CashierService - Architecture Hybride & Signals', () => {
  let service: CashierService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;

    TestBed.configureTestingModule({
      providers: [
        CashierService,
        {
          provide: SupabaseService,
          useValue: {
            isConfigured: () => false,
            ensureInitialized: vi.fn().mockResolvedValue(undefined),
            supabase: null,
          },
        },
        {
          provide: AuthService,
          useValue: {
            token: () => 'mock-jwt-token',
            currentUser: () => ({ id: 'usr-1', email: 'test@transmex.cm' }),
          },
        },
      ],
    });
    service = TestBed.inject(CashierService);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('devrait être initialisé avec un solde nul et une liste vide', () => {
    expect(service).toBeTruthy();
    expect(service.allTransactions().length).toBe(0);
    expect(service.currentBalance()).toBe(0);
    expect(service.paginationLabel()).toBe('0 / 0');
  });

  it('devrait sauvegarder via l’API serveur-relais et mettre à jour le Signal instantanément (cas nominal)', async () => {
    const mockCreatedDbRow = {
      id: 'tx-uuid-123',
      date: new Date('2026-09-06T10:00:00Z').toISOString(),
      libelle: 'Plein carburant camion',
      type_transaction: 'Carburant',
      type_description: 'Station Total',
      category: 'sortie' as const,
      matricule_vehicule: 'LT-5544-AA',
      first_name: 'Samuel',
      employee: 'Samuel Eboa',
      quantity: 50,
      montant: -75000,
      created_by: 'usr-1',
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        operation: mockCreatedDbRow,
      }),
    } as unknown as Response);

    const result = await service.saveOperationViaApi({
      libelle: 'Plein carburant camion',
      typeTransaction: 'Carburant',
      typeDescription: 'Station Total',
      category: 'sortie',
      matriculeVehicule: 'LT-5544-AA',
      firstName: 'Samuel',
      employee: 'Samuel Eboa',
      quantity: 50,
      montant: -75000,
    });

    // 1. Vérification de l'appel API avec le token d'autorisation
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/cahier/operations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer mock-jwt-token',
        }),
      })
    );

    // 2. Vérification de la mise à jour immédiate du Signal
    expect(result.success).toBe(true);
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].id).toBe('tx-uuid-123');
    expect(service.allTransactions()[0].libelle).toBe('Plein carburant camion');
    expect(service.currentBalance()).toBe(-75000);
  });

  it('devrait basculer en repli sécurisé si l’API serveur-relais renvoie une erreur', async () => {
    // Simulation d'une erreur 500 sur l'API serveur
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: 'Erreur serveur interne' }),
    } as unknown as Response);

    const result = await service.saveOperationViaApi({
      libelle: 'Dépannage urgence',
      typeTransaction: 'Maintenance',
      category: 'sortie',
      montant: -20000,
    });

    // Même en cas d'indisponibilité de l'API, l'état local du Signal est préservé
    expect(result.success).toBe(true);
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].libelle).toBe('Dépannage urgence');
    expect(service.currentBalance()).toBe(-20000);
  });

  it('devrait récupérer les opérations via l’API rapide dans loadTransactions()', async () => {
    const mockRows = [
      {
        id: 'row-1',
        date: new Date('2026-09-06T08:00:00Z').toISOString(),
        libelle: 'Versement Caisse',
        type_transaction: 'Apport',
        type_description: '',
        category: 'entree' as const,
        first_name: 'Admin',
        employee: 'Directeur',
        quantity: 1,
        montant: 500000,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        operations: mockRows,
      }),
    } as unknown as Response);

    await service.loadTransactions();

    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].libelle).toBe('Versement Caisse');
    expect(service.currentBalance()).toBe(500000);
  });

  it('devrait supprimer les éléments sélectionnés et recalculer les soldes', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true, deletedCount: 1 }),
    } as unknown as Response);

    // Ajout d'une opération initiale
    await service.saveOperationViaApi({
      libelle: 'Transaction à supprimer',
      montant: -10000,
      category: 'sortie',
    });

    expect(service.allTransactions().length).toBe(1);
    const id = service.allTransactions()[0].id;
    service.toggleSelectTransaction(id);

    expect(service.allTransactions()[0].selected).toBe(true);

    await service.deleteSelected();
    expect(service.allTransactions().length).toBe(0);
    expect(service.currentBalance()).toBe(0);
  });

  it('devrait filtrer les données réactivement avec les Signals de recherche', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        operation: {
          id: 'row-1',
          date: new Date().toISOString(),
          libelle: 'Frais de péage autoroute',
          type_transaction: 'Péage',
          category: 'sortie',
          montant: -5000,
        },
      }),
    } as unknown as Response);

    await service.saveOperationViaApi({
      libelle: 'Frais de péage autoroute',
      typeTransaction: 'Péage',
      category: 'sortie',
      montant: -5000,
    });

    service.setSearchQuery('péage');
    expect(service.filteredTransactions().length).toBe(1);

    service.setSearchQuery('carburant');
    expect(service.filteredTransactions().length).toBe(0);

    service.setSearchQuery('');
    expect(service.filteredTransactions().length).toBe(1);
  });
});
