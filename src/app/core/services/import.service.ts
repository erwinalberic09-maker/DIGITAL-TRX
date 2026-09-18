import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';
import {
  CASHIER_SERVICES,
  Service,
  TransactionStatus,
  TransactionTypeCategory,
} from '../models/cashier-transaction.model';
import { generateTransactionFingerprint } from '../utils/cashier-duplicate.util';

export interface ImportError {
  row: number;
  column?: string;
  message: string;
}

export interface ParsedImportRow {
  pieceComptable?: string;
  date: string;
  libelle: string;
  partenaire?: string;
  employee?: string;
  noDossier?: string;
  service?: Service;
  quantity?: number;
  montant: number;
  category: TransactionTypeCategory;
  status: TransactionStatus;
  isDuplicate?: boolean;
  duplicateReason?: string;
}

export interface ParsedImportResult {
  validRows: ParsedImportRow[];
  errors: ImportError[];
  totalRows: number;
}

@Injectable({
  providedIn: 'root',
})
export class ImportService {
  /**
   * Lit et analyse un fichier Excel (.xlsx, .xls) ou CSV
   */
  public async parseExcelOrCsvFile(file: File): Promise<ParsedImportResult> {
    const dataBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(dataBuffer, { type: 'array', cellDates: true });

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return {
        validRows: [],
        errors: [{ row: 0, message: 'Le fichier ne contient aucune feuille de calcul lisible.' }],
        totalRows: 0,
      };
    }

    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(firstSheet, {
      defval: '',
      raw: false,
    });

    const validRows: ParsedImportRow[] = [];
    const errors: ImportError[] = [];
    const seenFingerprints = new Map<string, number>();

    rawRows.forEach((row, index) => {
      const rowIndex = index + 2; // +2 en comptant la ligne d'en-tête (1-indexed)
      const parsed = this.validateAndTransformRow(row, rowIndex);

      if (parsed.error) {
        errors.push(parsed.error);
      } else if (parsed.data) {
        const fp = generateTransactionFingerprint({
          date: parsed.data.date,
          montant: parsed.data.montant,
          libelle: parsed.data.libelle,
          noDossier: parsed.data.noDossier,
          service: parsed.data.service,
        });

        if (seenFingerprints.has(fp)) {
          const firstRow = seenFingerprints.get(fp);
          errors.push({
            row: rowIndex,
            message: `Ligne en double dans le fichier : identique à la ligne ${firstRow} (Date: ${parsed.data.date}, Montant: ${parsed.data.montant} FCFA, Service: ${parsed.data.service || 'N/A'}, Libellé: "${parsed.data.libelle}").`,
          });
        } else {
          seenFingerprints.set(fp, rowIndex);
          validRows.push(parsed.data);
        }
      }
    });

    return {
      validRows,
      errors,
      totalRows: rawRows.length,
    };
  }

  /**
   * Valide et normalise une ligne brute issue du fichier
   */
  public validateAndTransformRow(
    row: Record<string, unknown>,
    rowIndex: number
  ): { data?: ParsedImportRow; error?: ImportError } {
    // Recherche tolérante des colonnes (insensible à la casse et aux espaces)
    const findValue = (keys: string[]): string => {
      for (const key of Object.keys(row)) {
        const cleanKey = key.trim().toLowerCase();
        if (keys.some((k) => cleanKey.includes(k.toLowerCase()))) {
          const val = row[key];
          return val !== null && val !== undefined ? String(val).trim() : '';
        }
      }
      return '';
    };

    // 1. Libellé (Obligatoire)
    const libelle = findValue(['libellé', 'libelle', 'description', 'motif', 'operation']);
    if (!libelle) {
      return {
        error: {
          row: rowIndex,
          column: 'Libellé',
          message: 'Le libellé de l’opération est obligatoire.',
        },
      };
    }

    // Helper pour parser un montant numérique propre
    const parseAmount = (raw: string): number | null => {
      if (!raw) return null;
      const clean = raw.replace(/\s/g, '').replace(/,/g, '.');
      const num = parseFloat(clean);
      return isNaN(num) ? null : num;
    };

    // 2. Détection des colonnes distinctes Entrée et Sortie
    const rawEntree = findValue(['entrée', 'entree', 'recette', 'recettes', 'credit']);
    const rawSortie = findValue(['sortie', 'sorties', 'dépense', 'depense', 'dépenses', 'depenses', 'debit']);

    const entreeAmount = parseAmount(rawEntree);
    const sortieAmount = parseAmount(rawSortie);

    let category: TransactionTypeCategory = 'sortie';
    let finalMontant: number;

    const hasEntree = entreeAmount !== null && entreeAmount > 0;
    const hasSortie = sortieAmount !== null && sortieAmount > 0;

    if (hasEntree && hasSortie) {
      return {
        error: {
          row: rowIndex,
          column: 'Montant',
          message: 'Une même opération ne peut pas être à la fois une Entrée et une Sortie. Veuillez renseigner une seule des deux colonnes.',
        },
      };
    } else if (hasEntree) {
      category = 'entree';
      finalMontant = Math.abs(entreeAmount);
    } else if (hasSortie) {
      category = 'sortie';
      finalMontant = -Math.abs(sortieAmount);
    } else {
      // Repli rétrocompatible : colonne unique "Montant" + colonne "Sens"
      const rawMontantStr = findValue(['montant', 'somme', 'valeur', 'total']);
      const legacyAmount = parseAmount(rawMontantStr);

      if (legacyAmount === null || legacyAmount === 0) {
        return {
          error: {
            row: rowIndex,
            column: 'Montant',
            message: 'Veuillez saisir un montant valide dans la colonne "Entrée" ou dans la colonne "Sortie".',
          },
        };
      }

      const sensValue = findValue(['sens', 'type', 'catégorie', 'categorie', 'nature']).toLowerCase();
      if (sensValue.includes('entree') || sensValue.includes('entrée') || sensValue.includes('credit') || sensValue.includes('appro')) {
        category = 'entree';
        finalMontant = Math.abs(legacyAmount);
      } else {
        category = 'sortie';
        finalMontant = -Math.abs(legacyAmount);
      }
    }

    // 4. Date (Normalisation JJ/MM/AAAA)
    const rawDate = findValue(['date', 'jour']);
    const dateFormatted = this.normalizeDate(rawDate);

    // 5. Service
    const rawService = findValue(['service', 'departement', 'département']).toUpperCase();
    let matchedService: Service | undefined = undefined;
    for (const srv of CASHIER_SERVICES) {
      if (rawService.includes(srv) || srv.includes(rawService)) {
        matchedService = srv;
        break;
      }
    }

    // 6. Partenaire / Employé
    const partenaire = findValue(['partenaire', 'tiers', 'client', 'fournisseur', 'bénéficiaire', 'beneficiaire', 'employé', 'employe', 'agent']);

    // 7. N° Dossier
    const noDossier = findValue(['dossier', 'n° dossier', 'no dossier', 'ref', 'reference', 'numéro dossier']);

    // 8. Quantité
    const rawQty = findValue(['quantité', 'quantite', 'qte', 'qty']);
    const parsedQty = rawQty ? parseInt(rawQty, 10) : undefined;
    const quantity = isNaN(Number(parsedQty)) ? undefined : parsedQty;

    return {
      data: {
        date: dateFormatted,
        libelle,
        partenaire: partenaire || undefined,
        employee: partenaire || undefined,
        noDossier: noDossier || undefined,
        service: matchedService,
        quantity,
        montant: finalMontant,
        category,
        status: 'draft',
      },
    };
  }

  /**
   * Normalise une chaîne de date en format JJ/MM/AAAA
   */
  public normalizeDate(dateStr: string): string {
    if (!dateStr) {
      const now = new Date();
      const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
      return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    }

    // Format JJ/MM/AAAA ou JJ-MM-AAAA
    const slashMatch = dateStr.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (slashMatch) {
      const day = slashMatch[1].padStart(2, '0');
      const month = slashMatch[2].padStart(2, '0');
      const year = slashMatch[3];
      return `${day}/${month}/${year}`;
    }

    // Format AAAA-MM-JJ (ISO)
    const isoMatch = dateStr.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (isoMatch) {
      const year = isoMatch[1];
      const month = isoMatch[2].padStart(2, '0');
      const day = isoMatch[3].padStart(2, '0');
      return `${day}/${month}/${year}`;
    }

    return dateStr;
  }

  /**
   * Génère et télécharge le fichier modèle Excel vierge pour la caissière
   */
  public downloadExcelTemplate(): void {
    const headers = [
      'Date (JJ/MM/AAAA)',
      'Libellé de l\'opération',
      'Entrée (FCFA)',
      'Sortie (FCFA)',
      'Service',
      'Partenaire / Employé',
      'N° Dossier',
      'Quantité',
    ];

    // Modèle vierge sans données de démonstration (uniquement les en-têtes)
    const worksheetData = [headers];
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);

    // Ajustement de la largeur des colonnes
    worksheet['!cols'] = [
      { wch: 18 }, // Date
      { wch: 35 }, // Libellé
      { wch: 18 }, // Entrée
      { wch: 18 }, // Sortie
      { wch: 16 }, // Service
      { wch: 26 }, // Partenaire
      { wch: 16 }, // N° Dossier
      { wch: 10 }, // Quantité
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Modèle Caisse');

    const fileName = 'modele_import_caisse.xlsx';
    XLSX.writeFile(workbook, fileName);
  }
}
