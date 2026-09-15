import { describe, it, expect, beforeEach } from 'vitest';
import { ImportService } from './import.service';

describe('ImportService', () => {
  let service: ImportService;

  beforeEach(() => {
    service = new ImportService();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('validateAndTransformRow', () => {
    it('should validate a nominal row with separate Sortie column', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': 'Achat fournitures de bureau',
        'Entrée': '',
        'Sortie': '15000',
        'Service': 'TRANSIT',
        'Partenaire': 'Fournisseur Papeterie',
        'N° Dossier': 'DOS-100',
        'Quantité': '2',
      };

      const result = service.validateAndTransformRow(row, 2);

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data?.libelle).toBe('Achat fournitures de bureau');
      expect(result.data?.montant).toBe(-15000);
      expect(result.data?.category).toBe('sortie');
      expect(result.data?.service).toBe('TRANSIT');
      expect(result.data?.quantity).toBe(2);
    });

    it('should validate a nominal row with separate Entrée column', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': 'Approvisionnement caisse principale',
        'Entrée (FCFA)': '500 000',
        'Sortie (FCFA)': '',
        'Service': 'DG',
        'Partenaire': 'Directeur Financier',
      };

      const result = service.validateAndTransformRow(row, 3);

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data?.category).toBe('entree');
      expect(result.data?.montant).toBe(500000);
      expect(result.data?.service).toBe('DG');
    });

    it('should reject row when both Entrée and Sortie are filled simultaneously', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': 'Erreur double saisie',
        'Entrée': '20000',
        'Sortie': '10000',
      };

      const result = service.validateAndTransformRow(row, 4);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Une même opération ne peut pas être à la fois une Entrée et une Sortie');
    });

    it('should reject row when neither Entrée nor Sortie is filled', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': 'Montants vides',
        'Entrée': '',
        'Sortie': '0',
      };

      const result = service.validateAndTransformRow(row, 5);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Veuillez saisir un montant valide');
    });

    it('should return error when libelle is missing', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': '',
        'Sortie': '5000',
      };

      const result = service.validateAndTransformRow(row, 6);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.column).toBe('Libellé');
    });

    it('should preserve backward compatibility with legacy Sens and Montant columns', () => {
      const legacyRow = {
        'Date': '15/09/2026',
        'Libellé': 'Ancien fichier format classique',
        'Sens': 'Entrée',
        'Montant': '75000',
      };

      const result = service.validateAndTransformRow(legacyRow, 7);
      expect(result.error).toBeUndefined();
      expect(result.data?.category).toBe('entree');
      expect(result.data?.montant).toBe(75000);
    });
  });

  describe('normalizeDate', () => {
    it('should format ISO YYYY-MM-DD into DD/MM/YYYY', () => {
      expect(service.normalizeDate('2026-09-15')).toBe('15/09/2026');
    });

    it('should keep valid DD/MM/YYYY dates intact', () => {
      expect(service.normalizeDate('15/09/2026')).toBe('15/09/2026');
    });
  });
});
