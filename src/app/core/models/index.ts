// ============================================================================
// BARIL D'EXPORTATION CENTRALISÉ - SCHÉMA ERP TRANSMEX (31 TABLES)
// ============================================================================

// 1. Utilisateurs, Sécurité & Authentification
export * from './auth.model';

// 2. Ressources Humaines & Gestion du Personnel
export * from './hr.model';

// 3. Produits, Répertoire & Stocks
export * from './inventory.model';

// 4. Achats, Ventes & Facturation
export * from './sales-purchases.model';

// 5. Caisse, Banque & Dépenses
export * from './finance-cash.model';

// 6. Comptabilité Générale & Rapports
export * from './accounting.model';
