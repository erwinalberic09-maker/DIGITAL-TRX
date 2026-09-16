/**
 * Utilitaire pur de détection des opérations de caisse en double
 * Critères d'unicité stricts :
 * Date + Montant + Libellé + N° de dossier/matricule + Service
 */

/**
 * Normalise une date pour comparaison exacte (YYYY-MM-DD)
 */
export function normalizeDateForComparison(dateStr?: string | null): string {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();
  
  // Format DD/MM/YYYY
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${day}`;
    }
  }

  // Format ISO ou YYYY-MM-DD
  if (trimmed.includes('-')) {
    const datePart = trimmed.split('T')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      const year = parts[0];
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  return trimmed;
}

/**
 * Normalise une chaîne textuelle (minuscules, sans espaces superflus)
 */
export function normalizeText(str?: string | null): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normalise un montant numérique pour comparaison stricte
 */
export function normalizeMontant(val: unknown): number {
  if (typeof val === 'number') {
    return isNaN(val) ? 0 : Math.round(val * 100) / 100;
  }
  if (!val) return 0;
  const cleanStr = String(val).replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleanStr);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

export interface TransactionComparisonKey {
  date: string;
  montant: number;
  libelle: string;
  noDossier: string;
  service: string;
}

/**
 * Génère la clé d'unicité standardisée pour une opération de caisse.
 * Format : `${date}|${montant}|${libelle}|${noDossier}|${service}`
 */
export function generateTransactionFingerprint(op: {
  date?: string | null;
  montant?: number | string | null;
  libelle?: string | null;
  noDossier?: string | null;
  matricule?: string | null;
  service?: string | null;
}): string {
  const normDate = normalizeDateForComparison(op.date);
  const normMontant = normalizeMontant(op.montant);
  const normLibelle = normalizeText(op.libelle);
  const normNoDossier = normalizeText(op.noDossier || op.matricule);
  const normService = normalizeText(op.service);

  return `${normDate}|${normMontant}|${normLibelle}|${normNoDossier}|${normService}`;
}

/**
 * Recherche si une opération donnée est un doublon d'une liste d'opérations existantes.
 * Retourne la transaction existante correspondante si trouvée, sinon undefined.
 */
export function findDuplicateTransaction<T extends {
  id?: string;
  date?: string | null;
  montant?: number | string | null;
  libelle?: string | null;
  noDossier?: string | null;
  service?: string | null;
}>(
  candidate: {
    id?: string;
    date?: string | null;
    montant?: number | string | null;
    libelle?: string | null;
    noDossier?: string | null;
    service?: string | null;
  },
  existingList: T[]
): T | undefined {
  const candidateFingerprint = generateTransactionFingerprint(candidate);
  if (!candidateFingerprint || candidateFingerprint === '||||') {
    return undefined;
  }

  return existingList.find((item) => {
    // Si on modifie une ligne existante, on ignore sa propre comparaison par ID
    if (candidate.id && item.id && candidate.id === item.id) {
      return false;
    }
    return generateTransactionFingerprint(item) === candidateFingerprint;
  });
}
