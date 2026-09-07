// ============================================================================
// MODÈLE ERP TRANSMEX : RESSOURCES HUMAINES & GESTION DU PERSONNEL
// Tables : departments, positions, employees, attendance, payroll, leave_requests
// ============================================================================

export type EmployeeContractType = 'CDI' | 'CDD' | 'Stage' | 'Prestataire' | 'Interim';
export type LeaveRequestStatus = 'en_attente' | 'approuve' | 'refuse' | 'annule';
export type LeaveType = 'conge_paye' | 'maladie' | 'maternite' | 'sans_solde' | 'exceptionnel';
export type AttendanceStatus = 'present' | 'retard' | 'absent_justifie' | 'absent_injustifie' | 'mission';

/**
 * Table : departments
 * Représente les départements structurels de l'entreprise
 */
export interface Department {
  id: string;
  name: string;
  code: string;
  description?: string;
  headId?: string; // Clé étrangère vers profiles(id)
  headName?: string;
  budgetAllocated?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Table : positions
 * Postes et intitulés de poste au sein des départements
 */
export interface Position {
  id: string;
  departmentId: string; // Clé étrangère vers departments(id)
  title: string;
  code: string;
  baseSalaryMin?: number;
  baseSalaryMax?: number;
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Table : employees
 * Fiche détaillée des collaborateurs et employés
 */
export interface Employee {
  id: string;
  profileId?: string; // Clé étrangère optionnelle vers profiles(id) pour liaison compte applicatif
  departmentId: string; // Clé étrangère vers departments(id)
  positionId: string; // Clé étrangère vers positions(id)
  matricule: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address?: string;
  nationalIdNumber?: string;
  dateOfBirth?: string;
  hireDate: string;
  contractType: EmployeeContractType;
  baseSalary: number;
  hourlyRate?: number;
  bankAccountNumber?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes (UI helpers)
  departmentName?: string;
  positionTitle?: string;
}

/**
 * Table : attendance
 * Suivi du pointage, des heures et de la présence
 */
export interface Attendance {
  id: string;
  employeeId: string; // Clé étrangère vers employees(id)
  date: string; // YYYY-MM-DD
  checkIn?: string; // HH:mm:ss ou ISO timestamp
  checkOut?: string;
  totalHoursWorked?: number;
  overtimeHours?: number;
  status: AttendanceStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Propriété jointe
  employeeName?: string;
}

/**
 * Table : payroll
 * Bulletins et fiches de paie mensuels
 */
export interface Payroll {
  id: string;
  employeeId: string; // Clé étrangère vers employees(id)
  month: number; // 1 - 12
  year: number;
  baseSalary: number;
  primes: number;
  deductions: number;
  taxDeductions: number;
  netSalary: number;
  paymentDate?: string;
  paymentMethod?: 'virement' | 'cheque' | 'especes';
  isPaid: boolean;
  slipPdfUrl?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Propriété jointe
  employeeName?: string;
  employeeMatricule?: string;
}

/**
 * Table : leave_requests
 * Demandes et historique des congés
 */
export interface LeaveRequest {
  id: string;
  employeeId: string; // Clé étrangère vers employees(id)
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason?: string;
  status: LeaveRequestStatus;
  approvedById?: string; // Clé étrangère vers profiles(id)
  approvedAt?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
  // Propriétés jointes
  employeeName?: string;
  approverName?: string;
}
