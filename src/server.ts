import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { normalizeUserRole } from './app/core/utils/role.utils';

// Charger les variables d'environnement depuis le fichier `.env` (si présent)
dotenv.config();

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Parsing JSON pour les requêtes d'API avec limite explicite
app.use(express.json({ limit: '256kb' }));

/**
 * Endpoint sécurisé fournissant l'URL et la clé anonyme publiques Supabase au client web.
 * Supporte /api/supabase-config et /api/config avec gestion de variabilité de nommage sur Vercel.
 */
const getSupabaseConfigHandler = (_req: express.Request, res: express.Response) => {
  const url =
    process.env['SUPABASE_URL'] ||
    process.env['PUBLIC_SUPABASE_URL'] ||
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
    process.env['VITE_SUPABASE_URL'] ||
    '';
  const anonKey =
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['VITE_SUPABASE_ANON_KEY'] ||
    '';
  res.json({
    url,
    anonKey,
    key: anonKey,
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
    configured: Boolean(url && anonKey),
  });
};

app.get('/api/supabase-config', getSupabaseConfigHandler);
app.get('/api/config', getSupabaseConfigHandler);

/**
 * Helper d'initialisation du client Supabase avec privilèges d'administration.
 * STRICT : Exige obligatoirement SUPABASE_SERVICE_ROLE_KEY (pas de fallback silencieux vers la clé anonyme).
 */
function getSupabaseAdmin() {
  const url = process.env['SUPABASE_URL'] || '';
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] || '';
  if (!url || !serviceRoleKey) {
    return null;
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Configuration des administrateurs système permanents (inviolables et extensibles via variable d'environnement ADMIN_EMAILS)
const DEFAULT_ADMIN_EMAILS = [
  'erwinalberic99@gmail.com',
  'admin@transmex.cm',
  'admin@transimex.cm',
  'admin@transmex.com',
];

const envAdminEmails = (process.env['ADMIN_EMAILS'] || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const PERMANENT_ADMIN_EMAILS = Array.from(new Set([...DEFAULT_ADMIN_EMAILS, ...envAdminEmails]));

/**
 * Fonction centrale et sécurisée de résolution de rôle serveur (RBAC).
 * SÉCURITÉ ABSOLUE : `user_metadata` est STRICTEMENT EXCLU de toute décision d'autorisation.
 * 1. Email admin permanent (erwinalberic99@gmail.com, etc.) -> 'admin'
 * 2. app_metadata.role (scellé serveur par Supabase Admin) -> si différent de 'employe'
 * 3. public.profiles.role (table SQL sécurisée)
 * 4. Défaut : 'employe'
 */
export async function resolveServerRole(
  supabaseAdmin: SupabaseClient,
  user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> }
): Promise<'admin' | 'caissiere' | 'manager' | 'employe'> {
  const email = (user.email || '').toLowerCase().trim();
  if (PERMANENT_ADMIN_EMAILS.includes(email)) {
    return 'admin';
  }

  const appRole = normalizeUserRole(user.app_metadata?.['role'] as string);
  if (appRole !== 'employe') {
    return appRole;
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  return profile?.role ? normalizeUserRole(profile.role) : 'employe';
}

/**
 * Middleware Express d'authentification : valide le jeton Bearer
 * via Supabase Auth admin client et attache l'utilisateur à req.user avec son rôle sécurisé.
 * SÉCURITÉ STRICTE : Ne fait JAMAIS confiance à `user_metadata` (éditable côté client par l'utilisateur).
 * Le rôle est extrait exclusivement via resolveServerRole.
 * FAIL-CLOSED : En cas d'indisponibilité du client d'administration, refuse la requête avec une erreur 500 explicite.
 */
export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (authHeader || '').replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Jeton d’authentification manquant dans l’en-tête Authorization' });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Service d’authentification indisponible : configuration serveur SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Jeton d’authentification invalide ou expiré' });
      return;
    }

    const user = data.user;
    const resolvedRole = await resolveServerRole(supabaseAdmin, user);

    (req as unknown as Record<string, unknown>)['user'] = {
      id: user.id,
      email: user.email,
      role: resolvedRole,
      app_metadata: user.app_metadata,
      user_metadata: user.user_metadata,
    };

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Échec de la validation de session';
    res.status(401).json({ error: message });
  }
}

/**
 * Middleware de contrôle d'accès basé sur les rôles (RBAC).
 * Exige que le rôle résolu de l'utilisateur fasse partie des rôles autorisés.
 */
export function requireRole(allowedRoles: ('admin' | 'caissiere' | 'manager' | 'employe')[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const user = (req as unknown as Record<string, unknown>)['user'] as { role?: string; email?: string } | undefined;
    if (!user || !user.role || !allowedRoles.includes(user.role as 'admin' | 'caissiere' | 'manager' | 'employe')) {
      res.status(403).json({ error: 'Accès refusé. Privilèges insuffisants pour exécuter cette opération.' });
      return;
    }
    next();
  };
}

/**
 * 4. Le "Garde-Fou" Ultime : La Validation Côté Serveur (RBAC Niveau 4)
 * Valide le JWT et vérifie le statut admin via resolveServerRole.
 * Auto-réparation immédiate : si l'utilisateur est légitime mais que son app_metadata
 * n'a pas encore été synchronisé, le serveur scelle son app_metadata et synchronise public.profiles.
 */
export async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (authHeader || '').replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Accès non autorisé. Jeton de sécurité requis.' });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Service d’administration indisponible : configuration serveur manquante' });
    return;
  }

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    const user = authData?.user;

    if (authError || !user) {
      res.status(401).json({ error: 'Session invalide ou expirée' });
      return;
    }

    const resolvedRole = await resolveServerRole(supabaseAdmin, user);
    if (resolvedRole !== 'admin') {
      res.status(403).json({ error: 'Accès refusé. Rôle administrateur requis.' });
      return;
    }

    const appRole = normalizeUserRole(user.app_metadata?.['role'] as string);
    // Auto-réparation si app_metadata n'est pas encore synchronisé (uniquement pour un admin authentifié et légitime)
    if (appRole !== 'admin') {
      try {
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          app_metadata: { ...user.app_metadata, role: 'admin' },
        });
        await supabaseAdmin.from('profiles').upsert(
          {
            id: user.id,
            email: user.email,
            role: 'admin',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        );
      } catch (syncErr) {
        console.warn('Auto-réparation du rôle admin (non-bloquante) :', syncErr);
      }
    }

    (req as unknown as Record<string, unknown>)['user'] = {
      id: user.id,
      email: user.email,
      role: 'admin',
      app_metadata: { ...user.app_metadata, role: 'admin' },
      user_metadata: user.user_metadata,
    };

    next();
  } catch {
    res.status(403).json({ error: 'Accès refusé. Rôle administrateur requis.' });
  }
}

/**
 * Récupération sécurisée de la liste des collaborateurs.
 * Réservé aux administrateurs (protégé par le middleware requireAdmin).
 */
const getCollaboratorsHandler = async (_req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();

  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    // 1. Récupérer tous les utilisateurs depuis Supabase Auth
    let authUsers: {
      id: string;
      email?: string;
      phone?: string;
      created_at?: string;
      last_sign_in_at?: string;
      updated_at?: string;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
    }[] = [];
    try {
      const { data: authData, error: authErr } = await adminClient.auth.admin.listUsers();
      if (!authErr && authData?.users) {
        authUsers = authData.users as typeof authUsers;
      }
    } catch {
      // Si la liste d'auth échoue, on continue avec profiles
    }

    // 2. Récupérer tous les profils de la table public.profiles
    const { data: profiles } = await adminClient
      .from('profiles')
      .select('*');

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    const processedIds = new Set<string>();

    const users: Record<string, unknown>[] = [];

    // Combiner les utilisateurs Auth
    for (const u of authUsers) {
      processedIds.add(u.id);
      const p = profileMap.get(u.id);

      const firstName = p?.first_name || (u.user_metadata?.['first_name'] as string) || (u.user_metadata?.['firstName'] as string) || '';
      const lastName = p?.last_name || (u.user_metadata?.['last_name'] as string) || (u.user_metadata?.['lastName'] as string) || '';
      const email = u.email || p?.email || '';
      const displayName = `${firstName} ${lastName}`.trim() || (u.user_metadata?.['display_name'] as string) || email || 'Utilisateur';
      const rawRole = (u.app_metadata?.['role'] as string) || p?.role || (u.user_metadata?.['role'] as string) || 'employe';
      const role = normalizeUserRole(rawRole);

      users.push({
        id: u.id,
        email,
        firstName,
        lastName,
        displayName,
        role,
        department: p?.department || 'Services Généraux',
        phone: p?.phone || u.phone || '',
        isActive: p?.is_active ?? true,
        avatarUrl: p?.avatar_url,
        createdAt: p?.created_at || u.created_at || new Date().toISOString(),
        lastLoginAt: u.last_sign_in_at || p?.last_login_at,
        updatedAt: p?.updated_at || u.updated_at,
      });
    }

    // Ajouter les profils qui ne seraient pas dans authUsers
    for (const p of (profiles || [])) {
      if (!processedIds.has(p.id)) {
        processedIds.add(p.id);
        users.push({
          id: p.id,
          email: p.email || '',
          firstName: p.first_name || '',
          lastName: p.last_name || '',
          displayName: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || 'Utilisateur',
          role: normalizeUserRole(p.role),
          department: p.department || 'Services Généraux',
          phone: p.phone || '',
          isActive: p.is_active ?? true,
          avatarUrl: p.avatar_url,
          createdAt: p.created_at || new Date().toISOString(),
          updatedAt: p.updated_at,
        });
      }
    }

    res.json({ users });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
    res.status(500).json({ error: message });
  }
};

app.get('/api/system/collaborators', requireAdmin, getCollaboratorsHandler);
app.get('/api/admin/users', requireAdmin, getCollaboratorsHandler);

/**
 * Endpoint de synchronisation et de restauration automatique du rôle.
 * Permet à un utilisateur authentifié de sceller et synchroniser son rôle légitime
 * dans app_metadata et public.profiles sans risque d'auto-promotion non autorisée.
 * SÉCURITÉ : Passe par requireAuth et utilise resolveServerRole (exclut totalement user_metadata).
 */
app.post('/api/auth/sync-role', requireAuth, async (req: express.Request, res: express.Response): Promise<void> => {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Configuration serveur Supabase indisponible' });
    return;
  }

  try {
    const user = (req as unknown as Record<string, unknown>)['user'] as {
      id: string;
      email?: string;
      role: 'admin' | 'caissiere' | 'manager' | 'employe';
      app_metadata?: Record<string, unknown>;
    };

    const targetRole = user.role;

    // Scellement dans app_metadata si nécessaire
    await supabaseAdmin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...user.app_metadata, role: targetRole },
    });

    // Scellement dans public.profiles
    await supabaseAdmin.from('profiles').upsert(
      {
        id: user.id,
        email: user.email,
        role: targetRole,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

    res.json({
      success: true,
      role: targetRole,
      isAdmin: targetRole === 'admin',
      userId: user.id,
      email: user.email,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur lors de la synchronisation du rôle';
    res.status(500).json({ error: message });
  }
});

/**
 * Endpoint sécurisé de création de collaborateurs.
 * Réservé aux administrateurs (protégé par le middleware requireAdmin) :
 * applique la séparation étanche app_metadata (rôle inviolable) vs user_metadata.
 */
const createCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const {
    email,
    password,
    firstName,
    lastName,
    displayName,
    role,
    department,
    phone,
    isActive,
    sites,
  } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email et mot de passe initial obligatoires' });
    return;
  }

  const validRoles = ['admin', 'manager', 'caissiere', 'employe'];
  if (!role || !validRoles.includes(role)) {
    res.status(400).json({ error: 'Le rôle Transmex est obligatoire et doit être défini explicitement (admin, manager, caissiere, employe)' });
    return;
  }

  const adminClient = getSupabaseAdmin();

  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    const computedDisplayName = displayName || `${firstName || ''} ${lastName || ''}`.trim() || email;
    const computedRole = normalizeUserRole(role);
    const sitesList = Array.isArray(sites) ? sites : (department ? [department] : []);

    // 2. Création avec privilèges élevés et étanchéité des métadonnées
    const { data: adminAuthData, error: adminAuthError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        role: computedRole,
        assignedSiteNames: sitesList,
      },
      user_metadata: {
        display_name: computedDisplayName,
        first_name: firstName || '',
        last_name: lastName || '',
        phone: phone || '',
      },
    });

    if (adminAuthError) {
      res.status(400).json({ error: adminAuthError.message });
      return;
    }
    const authUserId = adminAuthData.user.id;

    // 3. Synchronisation avec la table public.profiles
    const profilePayload = {
      id: authUserId,
      email,
      first_name: firstName || '',
      last_name: lastName || '',
      role: computedRole,
      department: department || 'Direction Générale',
      phone: phone || '',
      is_active: isActive !== undefined ? isActive : true,
      updated_at: new Date().toISOString(),
    };

    const { error: profileError } = await adminClient
      .from('profiles')
      .upsert(profilePayload);

    if (profileError) {
      console.error('Échec synchronisation profiles:', profileError.message);
      res.status(207).json({
        user: {
          id: authUserId,
          email,
          firstName: firstName || '',
          lastName: lastName || '',
          displayName: computedDisplayName,
          role: computedRole,
          department: department || 'Direction Générale',
          phone: phone || '',
          isActive: isActive !== undefined ? isActive : true,
          createdAt: new Date().toISOString(),
        },
        warning: `Compte Auth créé mais la synchronisation du profil public a rencontré une erreur: ${profileError.message}`,
      });
      return;
    }

    res.status(201).json({
      user: {
        id: authUserId,
        email,
        firstName: firstName || '',
        lastName: lastName || '',
        displayName: computedDisplayName,
        role: computedRole,
        department: department || 'Direction Générale',
        phone: phone || '',
        isActive: isActive !== undefined ? isActive : true,
        createdAt: new Date().toISOString(),
      },
      message: 'Collaborateur créé avec succès (droits scellés dans app_metadata et synchronisés)',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
    res.status(500).json({ error: message });
  }
};

app.post('/api/system/collaborators', requireAdmin, createCollaboratorHandler);
app.post('/api/admin/users', requireAdmin, createCollaboratorHandler);

/**
 * Modification d'un compte collaborateur (synchronisation auth.app_metadata + public.profiles)
 */
const updateCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const rawUserId = req.params['id'];
  const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
  if (!userId) {
    res.status(400).json({ error: 'Identifiant collaborateur requis' });
    return;
  }

  const { firstName, lastName, role, department, phone, isActive } = req.body;
  const adminClient = getSupabaseAdmin();

  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    const profileUpdates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (firstName !== undefined) profileUpdates['first_name'] = firstName;
    if (lastName !== undefined) profileUpdates['last_name'] = lastName;
    if (role !== undefined) profileUpdates['role'] = normalizeUserRole(role);
    if (department !== undefined) profileUpdates['department'] = department;
    if (phone !== undefined) profileUpdates['phone'] = phone;
    if (isActive !== undefined) profileUpdates['is_active'] = isActive;

    const { error: profileUpdateError } = await adminClient
      .from('profiles')
      .update(profileUpdates)
      .eq('id', userId);

    if (profileUpdateError) {
      console.error('Échec de la mise à jour public.profiles:', profileUpdateError.message);
      res.status(500).json({ error: `Erreur mise à jour profil: ${profileUpdateError.message}` });
      return;
    }

    const authUpdates: Record<string, unknown> = {};
    if (role !== undefined) {
      authUpdates['app_metadata'] = { role: normalizeUserRole(role) };
    }
    if (firstName !== undefined || lastName !== undefined) {
      authUpdates['user_metadata'] = {
        first_name: firstName,
        last_name: lastName,
        display_name: `${firstName || ''} ${lastName || ''}`.trim(),
      };
    }
    if (Object.keys(authUpdates).length > 0) {
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, authUpdates);
      if (authUpdateError) {
        console.error('Échec mise à jour auth.users:', authUpdateError.message);
        res.status(500).json({ error: `Erreur mise à jour auth: ${authUpdateError.message}` });
        return;
      }
    }

    res.json({ success: true, message: 'Collaborateur mis à jour avec succès' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur lors de la mise à jour';
    res.status(500).json({ error: message });
  }
};

app.patch('/api/system/collaborators/:id', requireAdmin, updateCollaboratorHandler);
app.patch('/api/admin/users/:id', requireAdmin, updateCollaboratorHandler);

/**
 * Suppression d'un compte collaborateur (auth.users + public.profiles).
 */
const deleteCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const rawUserId = req.params['id'];
  const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
  if (!userId) {
    res.status(400).json({ error: 'Identifiant collaborateur requis' });
    return;
  }

  // Protection anti-auto-suppression
  const currentAdminUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string } | undefined;
  if (currentAdminUser?.id && currentAdminUser.id === userId) {
    res.status(400).json({ error: 'Action refusée : vous ne pouvez pas supprimer votre propre compte administrateur.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(userId);
    if (authDeleteError) {
      console.error('Échec suppression auth.users:', authDeleteError.message);
      res.status(500).json({ error: `Erreur suppression auth: ${authDeleteError.message}` });
      return;
    }

    const { error: profileDeleteError } = await adminClient.from('profiles').delete().eq('id', userId);
    if (profileDeleteError) {
      console.error('Échec suppression public.profiles:', profileDeleteError.message);
      res.status(500).json({ error: `Erreur suppression profil: ${profileDeleteError.message}` });
      return;
    }

    res.json({ success: true, message: 'Compte collaborateur supprimé avec succès' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur lors de la suppression';
    res.status(500).json({ error: message });
  }
};

app.delete('/api/system/collaborators/:id', requireAdmin, deleteCollaboratorHandler);
app.delete('/api/admin/users/:id', requireAdmin, deleteCollaboratorHandler);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE HYBRIDE : ENDPOINTS API SERVEUR-RELAIS POUR LE CAHIER DE CAISSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Toutes les écritures et consultations prioritaires passent par ces routes.
 * Elles effectuent la validation des données, contrôlent les droits et interagissent
 * avec PostgreSQL via Supabase Admin avec la clé de service.
 */

/**
 * Enrichit les opérations de caisse avec leur numéro de pièce comptable séquentiel CSH1/AAAA/XXXXX
 * basé sur l'ordre chronologique d'enregistrement par exercice comptable.
 */
const attachPiecesComptables = async (
  client: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  rows: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> => {
  if (!rows || rows.length === 0) return rows;
  try {
    const { data: allSeqRows } = await client
      .from('cashier_transactions')
      .select('id, date, created_at')
      .order('date', { ascending: true })
      .order('created_at', { ascending: true });

    const pieceMap = new Map<string, string>();
    if (allSeqRows && Array.isArray(allSeqRows)) {
      const yearCounters: Record<string, number> = {};
      for (const r of allSeqRows) {
        const rawYear = r.date ? new Date(r.date).getFullYear() : 2026;
        const year = isNaN(rawYear) ? 2026 : rawYear;
        yearCounters[year] = (yearCounters[year] || 0) + 1;
        const seq = String(yearCounters[year]).padStart(5, '0');
        pieceMap.set(r.id, `CSH1/${year}/${seq}`);
      }
    }

    return rows.map((row) => {
      const rowId = typeof row['id'] === 'string' ? row['id'] : String(row['id'] || '');
      const rawDate = row['date'];
      const dateVal = typeof rawDate === 'string' || typeof rawDate === 'number' ? rawDate : Date.now();
      const fallbackYear = new Date(dateVal).getFullYear() || 2026;
      return {
        ...row,
        piece_comptable: pieceMap.get(rowId) || `CSH1/${fallbackYear}/00001`,
      };
    });
  } catch (e) {
    console.warn('Impossible de calculer la séquence de pièces comptables:', e);
    return rows;
  }
};

/**
 * Récupération des opérations de caisse (GET /api/cahier/operations & /api/cashier/transactions)
 * Supporte la pagination optionnelle via limit/offset (défaut limit: 100, max: 1000) pour préserver les ressources.
 */
const getOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  try {
    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];

    let limit = rawLimit ? Number(rawLimit) : 100;
    if (isNaN(limit) || limit <= 0) {
      limit = 100;
    }
    // Plafond de sécurité pour empêcher la saturation mémoire
    if (limit > 1000) {
      limit = 1000;
    }

    let offset = rawOffset ? Number(rawOffset) : 0;
    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }

    const { data, error, count } = await adminClient
      .from('cashier_transactions')
      .select('id, date, libelle, service, type_description, category, status, no_dossier, dossier_id, first_name, partenaire, employee, quantity, montant, solde_apres, selected, created_at, updated_at', { count: 'exact' })
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Erreur SQL lors de la lecture des opérations:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const enrichedRows = await attachPiecesComptables(adminClient, data || []);

    res.json({
      operations: enrichedRows,
      transactions: enrichedRows,
      total: count ?? (data?.length || 0),
      limit,
      offset,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la récupération des opérations';
    res.status(500).json({ error: message });
  }
};

/**
 * Sauvegarde d'une opération de caisse (POST /api/cahier/operations & /api/cashier/transactions)
 * Nettoie et valide les champs, vérifie l'autorisation de l'utilisateur, résout dossier_id et persiste dans PostgreSQL.
 */
const saveOperationHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const callerId: string | null = authenticatedUser?.id || null;

    const payload = req.body || {};
    const libelle = typeof payload.libelle === 'string' ? payload.libelle.trim() : '';
    const service = payload.service || payload.typeTransaction || payload.type_transaction || null;
    const typeDescription = payload.typeDescription || payload.type_description || null;
    const category = payload.category === 'sortie' ? 'sortie' : 'entree';
    const noDossier = payload.noDossier || payload.no_dossier || payload.matriculeVehicule || payload.matricule_vehicule || null;
    const firstName = payload.firstName || payload.first_name || null;
    const partenaire = payload.partenaire !== undefined ? payload.partenaire : null;
    const employee = payload.employee !== undefined ? payload.employee : null;
    const quantity = payload.quantity !== undefined && payload.quantity !== null ? Number(payload.quantity) : (service === 'Opérations' ? 1 : null);
    const montant = Number(payload.montant);

    if (!libelle) {
      res.status(400).json({ error: 'Le libellé de l’opération est obligatoire.' });
      return;
    }

    if (isNaN(montant)) {
      res.status(400).json({ error: 'Le montant de l’opération doit être un nombre valide.' });
      return;
    }

    let resolvedDossierId: string | null = payload.dossierId || payload.dossier_id || null;
    if (!resolvedDossierId && noDossier) {
      try {
        const { data: dossierRow } = await adminClient
          .from('dossiers')
          .select('id')
          .eq('no_dossier', noDossier)
          .maybeSingle();
        if (dossierRow?.id) {
          resolvedDossierId = dossierRow.id;
        }
      } catch {
        // En cas d'erreur de recherche, on conserve dossier_id à null
      }
    }

    const status = payload.status === 'posted' ? 'posted' : (payload.status === 'cancelled' ? 'cancelled' : 'draft');

    const rowToInsert = {
      libelle,
      service,
      type_description: typeDescription,
      category,
      status,
      no_dossier: noDossier,
      dossier_id: resolvedDossierId,
      first_name: firstName,
      partenaire,
      employee,
      employee_id: callerId,
      created_by: callerId,
      quantity,
      montant,
      date: payload.date ? (typeof payload.date === 'string' ? payload.date : new Date(payload.date).toISOString()) : new Date().toISOString(),
    };

    console.log(`[AUDIT CASHIER] Création opération par [${authenticatedUser?.email || callerId || 'inconnu'}] (rôle: ${authenticatedUser?.role || 'non-défini'}) : Montant=${montant}, Libellé="${libelle}"`);

    const { data, error } = await adminClient
      .from('cashier_transactions')
      .insert([rowToInsert])
      .select()
      .single();

    if (error) {
      console.error('Erreur SQL lors de l’insertion de l’opération:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const [enrichedOperation] = await attachPiecesComptables(adminClient, [data]);

    res.status(201).json({
      success: true,
      operation: enrichedOperation || data,
      transaction: enrichedOperation || data,
      message: 'Opération enregistrée avec succès',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la sauvegarde';
    res.status(500).json({ error: message });
  }
};

/**
 * Mise à jour d'une opération de caisse (PUT /api/cahier/operations/:id & /api/cashier/transactions/:id)
 * Réservé exclusivement aux rôles 'admin' et 'caissiere'.
 */
const updateOperationHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const rawId = req.params['id'];
    const targetId = Array.isArray(rawId) ? rawId[0] : rawId;

    if (!targetId) {
      res.status(400).json({ error: 'Identifiant d’opération manquant' });
      return;
    }

    const updateData: Record<string, unknown> = {};

    // RÈGLE MÉTIER : chacun ne modifie que ce qu'il a lui-même enregistré.
    // Un manager ne peut pas modifier une opération saisie par un caissier, et un
    // caissier ne peut pas modifier celle d'un collègue. Seul un admin déroge à la règle.
    // (Miroir applicatif de la policy RLS "cashier_transactions_update_own_or_admin".)
    if (authenticatedUser?.role !== 'admin') {
      const { data: existingRow, error: fetchError } = await adminClient
        .from('cashier_transactions')
        .select('created_by')
        .eq('id', targetId)
        .maybeSingle();

      if (fetchError) {
        res.status(500).json({ error: `Erreur lors de la vérification des droits: ${fetchError.message}` });
        return;
      }
      if (!existingRow) {
        res.status(404).json({ error: 'Opération introuvable' });
        return;
      }
      if (existingRow.created_by && existingRow.created_by !== authenticatedUser?.id) {
        res.status(403).json({ error: 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.' });
        return;
      }
      if (!existingRow.created_by && authenticatedUser?.id) {
        updateData['created_by'] = authenticatedUser.id;
        updateData['employee_id'] = authenticatedUser.id;
      }
    }

    const payload = req.body || {};

    if (payload.libelle !== undefined) {
      const libelle = typeof payload.libelle === 'string' ? payload.libelle.trim() : '';
      if (!libelle) {
        res.status(400).json({ error: 'Le libellé ne peut pas être vide' });
        return;
      }
      updateData['libelle'] = libelle;
    }

    if (payload.service !== undefined || payload.typeTransaction !== undefined || payload.type_transaction !== undefined) {
      updateData['service'] = payload.service ?? payload.typeTransaction ?? payload.type_transaction ?? null;
    }

    if (payload.typeDescription !== undefined || payload.type_description !== undefined) {
      updateData['type_description'] = payload.typeDescription ?? payload.type_description ?? null;
    }

    if (payload.category !== undefined) {
      updateData['category'] = payload.category === 'sortie' ? 'sortie' : 'entree';
    }

    if (payload.status !== undefined) {
      updateData['status'] = payload.status === 'posted' ? 'posted' : (payload.status === 'cancelled' ? 'cancelled' : 'draft');
    }

    if (payload.noDossier !== undefined || payload.no_dossier !== undefined || payload.matriculeVehicule !== undefined || payload.matricule_vehicule !== undefined) {
      const resolvedNoDossier = payload.noDossier ?? payload.no_dossier ?? payload.matriculeVehicule ?? payload.matricule_vehicule ?? null;
      updateData['no_dossier'] = resolvedNoDossier;
      if (resolvedNoDossier && payload.dossier_id === undefined && payload.dossierId === undefined) {
        try {
          const { data: dossierRow } = await adminClient
            .from('dossiers')
            .select('id')
            .eq('no_dossier', resolvedNoDossier)
            .maybeSingle();
          if (dossierRow?.id) {
            updateData['dossier_id'] = dossierRow.id;
          }
        } catch {
          // Ignore
        }
      }
    }

    if (payload.dossier_id !== undefined || payload.dossierId !== undefined) {
      updateData['dossier_id'] = payload.dossier_id ?? payload.dossierId ?? null;
    }

    if (payload.firstName !== undefined || payload.first_name !== undefined) {
      updateData['first_name'] = payload.firstName ?? payload.first_name ?? null;
    }

    if (payload.partenaire !== undefined) {
      updateData['partenaire'] = payload.partenaire ?? null;
    }

    if (payload.employee !== undefined) {
      updateData['employee'] = payload.employee ?? null;
    }

    if (payload.quantity !== undefined) {
      if (payload.quantity === null) {
        updateData['quantity'] = null;
      } else {
        const quantity = Number(payload.quantity);
        updateData['quantity'] = isNaN(quantity) ? null : quantity;
      }
    }

    if (payload.montant !== undefined) {
      const montant = Number(payload.montant);
      if (isNaN(montant)) {
        res.status(400).json({ error: 'Le montant de l’opération doit être un nombre valide' });
        return;
      }
      updateData['montant'] = montant;
    }

    if (payload.date !== undefined && payload.date) {
      updateData['date'] = typeof payload.date === 'string' ? payload.date : new Date(payload.date).toISOString();
    }

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ error: 'Aucun champ à modifier fourni' });
      return;
    }

    updateData['updated_at'] = new Date().toISOString();

    console.log(`[AUDIT CASHIER] Modification opération [${targetId}] par [${authenticatedUser?.email || authenticatedUser?.id || 'inconnu'}] (rôle: ${authenticatedUser?.role || 'non-défini'}) :`, Object.keys(updateData));

    const { data, error } = await adminClient
      .from('cashier_transactions')
      .update(updateData)
      .eq('id', targetId)
      .select()
      .single();

    if (error) {
      console.error('Erreur SQL lors de la mise à jour de l’opération:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const [enrichedOperation] = await attachPiecesComptables(adminClient, [data]);

    res.json({
      success: true,
      operation: enrichedOperation || data,
      transaction: enrichedOperation || data,
      message: 'Opération modifiée avec succès',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la modification';
    res.status(500).json({ error: message });
  }
};

/**
 * Suppression d'opérations de caisse (DELETE /api/cahier/operations & /api/cashier/transactions)
 * SÉCURITÉ CRITIQUE : Réservé strictement aux administrateurs ('admin') en accord avec les policies RLS.
 */
const deleteOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const paramId = req.params['id'];
    const singleId = Array.isArray(paramId) ? paramId[0] : paramId;
    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const targetIds: string[] = singleId ? [singleId] : bodyIds;

    if (targetIds.length === 0) {
      res.status(400).json({ error: 'Aucun identifiant d’opération fourni pour la suppression' });
      return;
    }

    if (targetIds.length > 100) {
      res.status(400).json({ error: 'Limite dépassée : impossible de supprimer plus de 100 opérations par requête' });
      return;
    }

    console.warn(`[AUDIT CASHIER] Suppression de ${targetIds.length} opération(s) [${targetIds.join(', ')}] initiée par [${authenticatedUser?.email || authenticatedUser?.id || 'inconnu'}] (rôle: ${authenticatedUser?.role || 'non-défini'})`);

    const { error, count } = await adminClient
      .from('cashier_transactions')
      .delete({ count: 'exact' })
      .in('id', targetIds);

    if (error) {
      console.error('Erreur SQL lors de la suppression d’opérations:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({
      success: true,
      deletedCount: count ?? targetIds.length,
      message: `${targetIds.length} opération(s) supprimée(s) avec succès`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la suppression';
    res.status(500).json({ error: message });
  }
};

// Déclaration des routes de caisse sécurisées par RBAC strict
app.get('/api/cahier/operations', requireAuth, getOperationsHandler);
app.get('/api/cashier/transactions', requireAuth, getOperationsHandler);
app.get('/api/system/operations', requireAuth, getOperationsHandler);

// Écriture : réservée aux Administrateurs et Caissières
app.post('/api/cahier/operations', requireAuth, requireRole(['admin', 'caissiere', 'manager']), saveOperationHandler);
app.post('/api/cashier/transactions', requireAuth, requireRole(['admin', 'caissiere', 'manager']), saveOperationHandler);

app.put('/api/cahier/operations/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager']), updateOperationHandler);
app.put('/api/cashier/transactions/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager']), updateOperationHandler);
app.patch('/api/cahier/operations/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager']), updateOperationHandler);
app.patch('/api/cashier/transactions/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager']), updateOperationHandler);

// Suppression : réservée strictement aux Administrateurs
app.delete('/api/cahier/operations/:id', requireAuth, requireRole(['admin']), deleteOperationsHandler);
app.delete('/api/cashier/transactions/:id', requireAuth, requireRole(['admin']), deleteOperationsHandler);
app.delete('/api/cahier/operations', requireAuth, requireRole(['admin']), deleteOperationsHandler);
app.delete('/api/cashier/transactions', requireAuth, requireRole(['admin']), deleteOperationsHandler);

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

/**
 * Serve static files from /browser
 * - Les fichiers versionnés (JS, CSS, polices, images) bénéficient du cache immutable 1 an en production.
 * - Seuls les fichiers HTML restent en no-cache, no-store pour garantir la fraîcheur applicative.
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: process.env['NODE_ENV'] === 'production' ? '1y' : '0',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (process.env['NODE_ENV'] === 'production') {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
    index: false,
    redirect: false,
  }),
);

/**
 * Traite les requêtes de rendu Angular SSR :
 * Transmet l'objet Express `req` (contenant les en-têtes et cookies HTTP Supabase `sb-*-auth-token`)
 * à l'engine `AngularNodeAppEngine` afin que SupabaseService réhydrate la session SSR avant le rendu HTML.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
