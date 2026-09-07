import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { ROLE_DEFINITIONS, UserRole } from '../../core/models/auth.model';
import { UserService } from '../../core/services/user.service';

@Component({
  selector: 'app-hr-management',
  imports: [SlicePipe],
  templateUrl: './hr-management.html',
  styleUrl: './hr-management.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HrManagement {
  private readonly userService = inject(UserService);

  public readonly users = this.userService.users;
  public readonly selectedDepartment = signal<string>('all');
  public readonly searchQuery = signal<string>('');

  public readonly departments = computed(() => {
    const set = new Set<string>();
    set.add('all');
    this.users().forEach((u) => {
      if (u.department) set.add(u.department);
    });
    return Array.from(set);
  });

  public readonly filteredCollaborators = computed(() => {
    const dept = this.selectedDepartment();
    const query = this.searchQuery().toLowerCase().trim();
    const list = this.users();

    return list.filter((u) => {
      const matchDept = dept === 'all' || u.department === dept;
      const matchQuery =
        !query ||
        u.firstName.toLowerCase().includes(query) ||
        u.lastName.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query) ||
        (u.department && u.department.toLowerCase().includes(query));

      return matchDept && matchQuery;
    });
  });

  public getRoleLabel(role: UserRole): string {
    return ROLE_DEFINITIONS[role]?.label || role;
  }
}
