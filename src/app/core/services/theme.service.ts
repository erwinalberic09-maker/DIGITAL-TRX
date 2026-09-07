import { Injectable, signal, effect } from '@angular/core';

export type AppTheme = 'dark' | 'light';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private readonly storageKey = 'transimex_app_theme';

  // Thème actif avec 'dark' par défaut (thème Odoo ERP du projet)
  public readonly currentTheme = signal<AppTheme>(this.getInitialTheme());

  constructor() {
    // Effet pour synchroniser la classe sur l'élément document racine
    effect(() => {
      const theme = this.currentTheme();
      this.applyTheme(theme);
    });
  }

  private getInitialTheme(): AppTheme {
    try {
      const savedTheme = localStorage.getItem(this.storageKey) as AppTheme | null;
      if (savedTheme === 'dark' || savedTheme === 'light') {
        return savedTheme;
      }
    } catch {
      // Ignorer si localStorage est inaccessible
    }
    return 'dark';
  }

  private applyTheme(theme: AppTheme): void {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      if (theme === 'dark') {
        root.classList.add('dark');
        root.classList.remove('light');
        root.setAttribute('data-theme', 'dark');
      } else {
        root.classList.remove('dark');
        root.classList.add('light');
        root.setAttribute('data-theme', 'light');
      }
    }

    try {
      localStorage.setItem(this.storageKey, theme);
    } catch {
      // Ignorer
    }
  }

  public toggleTheme(): void {
    this.currentTheme.update((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  public setTheme(theme: AppTheme): void {
    this.currentTheme.set(theme);
  }

  public isDarkMode(): boolean {
    return this.currentTheme() === 'dark';
  }
}
