import { Injectable, PLATFORM_ID, inject, signal, computed, makeStateKey, TransferState } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

const SUPABASE_CONFIG_KEY = makeStateKey<SupabaseConfig>('supabase.config');

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private readonly transferState = inject(TransferState);

  private client: SupabaseClient | null = null;
  private readonly _isConfigured = signal<boolean>(false);
  private readonly _supabaseUrl = signal<string>('');
  private readonly _isInitialized = signal<boolean>(false);

  public readonly isConfigured = this._isConfigured.asReadonly();
  public readonly supabaseUrl = this._supabaseUrl.asReadonly();
  public readonly isReady = computed(() => this._isConfigured() && this.client !== null);
  public readonly isInitialized = this._isInitialized.asReadonly();

  private initPromise: Promise<boolean> | null = null;

  constructor() {
    this.initSupabaseClient();
  }

  public get supabase(): SupabaseClient | null {
    return this.client;
  }

  /**
   * Initialise le client Supabase compatible SSR avec cookies HTTP et persistance :
   * 1. Côté serveur (SSR) : lit process.env, utilise createServerClient avec extraction des cookies de la requête.
   * 2. Côté client : lit TransferState/API, utilise createBrowserClient avec persistSession et autoRefreshToken.
   */
  public initSupabaseClient(): void {
    let url = '';
    let key = '';

    if (!this.isBrowser) {
      // Côté serveur (SSR) : lecture directe depuis l'environnement
      if (typeof process !== 'undefined' && process.env) {
        url = process.env['SUPABASE_URL'] || '';
        key = process.env['SUPABASE_ANON_KEY'] || '';
      }

      if (url && key) {
        this.transferState.set(SUPABASE_CONFIG_KEY, { url, anonKey: key });
      }
      this.applyConfig(url, key);
      this._isInitialized.set(true);
    } else {
      // Côté navigateur : récupération immédiate depuis le TransferState
      const transferredConfig = this.transferState.get(SUPABASE_CONFIG_KEY, null);
      if (transferredConfig && transferredConfig.url && transferredConfig.anonKey) {
        url = transferredConfig.url;
        key = transferredConfig.anonKey;
        this.applyConfig(url, key);
        this._isInitialized.set(true);
      } else {
        // Déclenche l'initialisation asynchrone sans bloquer le constructeur
        this.ensureInitialized();
      }
    }
  }

  /**
   * Garantit que le client Supabase est initialisé avant toute action (login, requêtes).
   * Protégé contre les appels concurrents via promesse partagée.
   */
  public async ensureInitialized(): Promise<boolean> {
    if (this._isConfigured() && this.client) {
      this._isInitialized.set(true);
      return true;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (!this.isBrowser) {
        this._isInitialized.set(true);
        return this._isConfigured();
      }

      try {
        const response = await fetch('/api/supabase-config', {
          headers: { Accept: 'application/json' },
          cache: 'no-cache',
        });
        if (response.ok) {
          const config: SupabaseConfig = await response.json();
          if (config.url && config.anonKey) {
            this.applyConfig(config.url, config.anonKey);
          }
        }
      } catch (err) {
        console.warn('Impossible de joindre /api/supabase-config lors de l’initialisation client:', err);
      } finally {
        this._isInitialized.set(true);
      }

      return this._isConfigured();
    })();

    const result = await this.initPromise;
    this.initPromise = null;
    return result;
  }

  private applyConfig(url: string, key: string): void {
    const isValid = !!(
      url &&
      key &&
      (url.startsWith('https://') || url.startsWith('http://')) &&
      !url.includes('placeholder') &&
      !url.includes('your-project') &&
      !url.includes('demo-transmex')
    );

    this._isConfigured.set(isValid);
    this._supabaseUrl.set(url);

    if (isValid) {
      try {
        if (this.isBrowser) {
          // Client Navigateur : createBrowserClient gère document.cookie + localStorage avec rafraîchissement automatique
          this.client = createBrowserClient(url, key, {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true,
              flowType: 'pkce',
            },
            cookieOptions: {
              name: 'sb-auth-token',
              maxAge: 365 * 24 * 60 * 60,
              domain: '',
              sameSite: 'lax',
              path: '/',
            },
          });
        } else {
          // Client Serveur (SSR)
          this.client = createServerClient(url, key, {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
            },
            cookies: {
              getAll: () => [],
              setAll: () => {
                // Pas d'écriture de cookies côté serveur en SSR
              },
            },
          });
        }
      } catch {
        this.client = null;
        this._isConfigured.set(false);
      }
    } else {
      this.client = null;
    }
  }
}
