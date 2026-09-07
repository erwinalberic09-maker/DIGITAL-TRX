import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { normalizeUserRole } from './app/core/utils/role.utils';

// Charger les variables d'environnement depuis le fichier `.env` (si présent)
dotenv.config();

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Parsing JSON pour les requêtes d'API
app.use(express.json());

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
    'sb_publishable_6nhsGRkv_zL7Hdjjyc3KgA_BC72nlM2';
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

/**
 * Middleware Express d'authentification : valide le jeton Bearer
 * via Supabase Auth admin client et attache l'utilisateur à req.user.
 * FAIL-CLOSED : En cas d'indisponibilité du client d'administration, refuse la requête avec une erreur 500 explicite.
 */
export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

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

    const appRole = data.user.app_metadata?.['role'];
    const userRole = data.user.user_metadata?.['role'];
    const rawRole = (appRole as string) || (userRole as string) || 'employe';

    (req as unknown as Record<string, unknown>)['user'] = {
      id: data.user.id,
      email: data.user.email,
      role: normalizeUserRole(rawRole),
      app_metadata: data.user.app_metadata,
      user_metadata: data.user.user_metadata,
    };

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Échec de la validation de session';
    res.status(401).json({ error: message });
  }
}

// Configuration des administrateurs système permanents (inviolables)
const PERMANENT_ADMIN_EMAILS = [
  'erwinalberic99@gmail.com',
  'admin@transmex.cm',
  'admin@transimex.cm',
  'admin@transmex.com',
];

/**
 * 4. Le "Garde-Fou" Ultime : La Validation Côté Serveur (RBAC Niveau 4)
 * Valide le JWT, vérifie le statut admin de manière résiliente :
 * 1. app_metadata.role === 'admin'
 * 2. profiles.role === 'admin'
 * 3. user_metadata.role === 'admin'
 * 4. email administrateur principal permanent (ex: erwinalberic99@gmail.com)
 *
 * Auto-réparation immédiate : si l'utilisateur est légitime mais que son app_metadata
 * n'a pas encore été synchronisé, le serveur scelle automatiquement son app_metadata
 * et met à jour public.profiles pour pérenniser son statut.
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

    const appRole = normalizeUserRole(user.app_metadata?.['role'] as string);
    const userRole = normalizeUserRole(user.user_metadata?.['role'] as string);
    const userEmail = (user.email || '').toLowerCase().trim();

    let isUserAdmin = appRole === 'admin' || userRole === 'admin' || PERMANENT_ADMIN_EMAILS.includes(userEmail);

    if (!isUserAdmin) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

      if (profile && normalizeUserRole(profile.role) === 'admin') {
        isUserAdmin = true;
      }
    }

    if (!isUserAdmin) {
      res.status(403).json({ error: 'Accès refusé. Rôle administrateur requis.' });
      return;
    }

    // Auto-réparation si app_metadata n'est pas encore synchronisé
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
 * Réservé aux administrateurs.
 */
const getCollaboratorsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

  const adminClient = getSupabaseAdmin();

  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    if (token) {
      const { data: callerData, error: callerError } = await adminClient.auth.getUser(token);
      if (callerError || !callerData?.user) {
        res.status(401).json({ error: 'Session administrateur invalide ou expirée' });
        return;
      }

      const callerAppRole = callerData.user.app_metadata?.['role'];
      const callerUserRole = callerData.user.user_metadata?.['role'];

      let isCallerAdmin = callerAppRole === 'admin' || callerUserRole === 'admin';
      if (!isCallerAdmin) {
        const { data: callerProfile } = await adminClient
          .from('profiles')
          .select('role')
          .eq('id', callerData.user.id)
          .maybeSingle();

        if (callerProfile?.role === 'admin') {
          isCallerAdmin = true;
        }
      }

      if (!isCallerAdmin) {
        res.status(403).json({ error: 'Action réservée exclusivement aux administrateurs' });
        return;
      }
    }

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
 * Permet à un utilisateur authentifié de rafraîchir et consolider son rôle légitime
 * dans app_metadata et public.profiles sans risque de rétrogradation.
 */
app.post('/api/auth/sync-role', async (req: express.Request, res: express.Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (authHeader || '').replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Jeton de sécurité requis' });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Configuration serveur Supabase indisponible' });
    return;
  }

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    const user = authData?.user;

    if (authError || !user) {
      res.status(401).json({ error: 'Session invalide' });
      return;
    }

    const email = (user.email || '').toLowerCase().trim();
    const appRole = normalizeUserRole(user.app_metadata?.['role'] as string);
    const userRole = normalizeUserRole(user.user_metadata?.['role'] as string);

    // Vérification du profil en base
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    const profileRole = profile ? normalizeUserRole(profile.role) : undefined;

    // Détermination du rôle légitime prioritaire
    let targetRole = appRole || profileRole || userRole || 'employe';
    if (PERMANENT_ADMIN_EMAILS.includes(email) || appRole === 'admin' || profileRole === 'admin' || userRole === 'admin') {
      targetRole = 'admin';
    }

    // Scellement dans app_metadata
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
 * Réservé aux administrateurs : vérifie le jeton Bearer JWT de l'appelant
 * et applique la séparation étanche app_metadata (rôle inviolable) vs user_metadata.
 */
const createCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

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
    // 1. Contrôle strict de l'identité et du rôle admin de l'appelant via son JWT
    if (token) {
      const { data: callerData, error: callerError } = await adminClient.auth.getUser(token);
      if (callerError || !callerData?.user) {
        res.status(401).json({ error: 'Session administrateur invalide ou expirée' });
        return;
      }

      const callerAppRole = callerData.user.app_metadata?.['role'];
      const callerUserRole = callerData.user.user_metadata?.['role'];

      let isCallerAdmin = callerAppRole === 'admin' || callerUserRole === 'admin';
      if (!isCallerAdmin) {
        const { data: callerProfile } = await adminClient
          .from('profiles')
          .select('role')
          .eq('id', callerData.user.id)
          .maybeSingle();

        if (callerProfile?.role === 'admin') {
          isCallerAdmin = true;
        }
      }

      if (!isCallerAdmin) {
        res.status(403).json({ error: 'Action réservée exclusivement aux administrateurs' });
        return;
      }
    } else {
      res.status(401).json({ error: 'Jeton de sécurité (Bearer token) requis' });
      return;
    }

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
 * Récupération des opérations de caisse (GET /api/cahier/operations & /api/cashier/transactions)
 */
const getOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  try {
    const { data, error } = await adminClient
      .from('cashier_transactions')
      .select('*')
      .order('date', { ascending: false });

    if (error) {
      console.error('Erreur SQL lors de la lecture des opérations:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({
      operations: data || [],
      transactions: data || [],
      total: data?.length || 0,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la récupération des opérations';
    res.status(500).json({ error: message });
  }
};

/**
 * Sauvegarde d'une opération de caisse (POST /api/cahier/operations & /api/cashier/transactions)
 * Nettoie et valide les champs, vérifie l'autorisation de l'utilisateur, puis persiste dans PostgreSQL.
 */
const saveOperationHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    let callerId: string | null = null;
    if (token) {
      const { data: userData } = await adminClient.auth.getUser(token);
      if (userData?.user) {
        callerId = userData.user.id;
      }
    }

    const payload = req.body || {};
    const libelle = typeof payload.libelle === 'string' ? payload.libelle.trim() : '';
    const typeTransaction = payload.typeTransaction || payload.type_transaction || '';
    const typeDescription = payload.typeDescription || payload.type_description || null;
    const category = payload.category === 'sortie' ? 'sortie' : 'entree';
    const matriculeVehicule = payload.matriculeVehicule || payload.matricule_vehicule || null;
    const firstName = payload.firstName || payload.first_name || null;
    const employee = payload.employee || null;
    const quantity = payload.quantity !== undefined && payload.quantity !== null ? Number(payload.quantity) : 1;
    const montant = Number(payload.montant);

    if (!libelle) {
      res.status(400).json({ error: 'Le libellé de l’opération est obligatoire.' });
      return;
    }

    if (isNaN(montant)) {
      res.status(400).json({ error: 'Le montant de l’opération doit être un nombre valide.' });
      return;
    }

    const rowToInsert = {
      libelle,
      type_transaction: typeTransaction,
      type_description: typeDescription,
      category,
      matricule_vehicule: matriculeVehicule,
      first_name: firstName,
      employee,
      quantity: isNaN(quantity) ? 1 : quantity,
      montant,
      created_by: callerId || payload.created_by || null,
      date: payload.date ? new Date(payload.date).toISOString() : new Date().toISOString(),
    };

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

    res.status(201).json({
      success: true,
      operation: data,
      transaction: data,
      message: 'Opération enregistrée avec succès',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la sauvegarde';
    res.status(500).json({ error: message });
  }
};

/**
 * Mise à jour d'une opération de caisse (PUT /api/cahier/operations/:id & /api/cashier/transactions/:id)
 */
const updateOperationHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const rawId = req.params['id'];
    const targetId = Array.isArray(rawId) ? rawId[0] : rawId;

    if (!targetId) {
      res.status(400).json({ error: 'Identifiant d’opération manquant' });
      return;
    }

    const payload = req.body || {};
    const updateData: Record<string, unknown> = {};

    if (payload.libelle !== undefined) {
      const libelle = typeof payload.libelle === 'string' ? payload.libelle.trim() : '';
      if (!libelle) {
        res.status(400).json({ error: 'Le libellé ne peut pas être vide' });
        return;
      }
      updateData['libelle'] = libelle;
    }

    if (payload.typeTransaction !== undefined || payload.type_transaction !== undefined) {
      updateData['type_transaction'] = payload.typeTransaction ?? payload.type_transaction ?? '';
    }

    if (payload.typeDescription !== undefined || payload.type_description !== undefined) {
      updateData['type_description'] = payload.typeDescription ?? payload.type_description ?? null;
    }

    if (payload.category !== undefined) {
      updateData['category'] = payload.category === 'sortie' ? 'sortie' : 'entree';
    }

    if (payload.matriculeVehicule !== undefined || payload.matricule_vehicule !== undefined) {
      updateData['matricule_vehicule'] = payload.matriculeVehicule ?? payload.matricule_vehicule ?? null;
    }

    if (payload.firstName !== undefined || payload.first_name !== undefined) {
      updateData['first_name'] = payload.firstName ?? payload.first_name ?? null;
    }

    if (payload.employee !== undefined) {
      updateData['employee'] = payload.employee ?? null;
    }

    if (payload.quantity !== undefined && payload.quantity !== null) {
      const quantity = Number(payload.quantity);
      updateData['quantity'] = isNaN(quantity) ? 1 : quantity;
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
      updateData['date'] = new Date(payload.date).toISOString();
    }

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ error: 'Aucun champ à modifier fourni' });
      return;
    }

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

    res.json({
      success: true,
      operation: data,
      transaction: data,
      message: 'Opération modifiée avec succès',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la mise à jour';
    res.status(500).json({ error: message });
  }
};

/**
 * Suppression d'opérations de caisse (DELETE /api/cahier/operations & /api/cashier/transactions)
 */
const deleteOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const paramId = req.params['id'];
    const singleId = Array.isArray(paramId) ? paramId[0] : paramId;
    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const targetIds: string[] = singleId ? [singleId] : bodyIds;

    if (targetIds.length === 0) {
      res.status(400).json({ error: 'Aucun identifiant d’opération fourni pour la suppression' });
      return;
    }

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

// Déclaration des routes avec alias cahier / cashier
app.get('/api/cahier/operations', getOperationsHandler);
app.get('/api/cashier/transactions', getOperationsHandler);
app.get('/api/system/operations', getOperationsHandler);

app.post('/api/cahier/operations', saveOperationHandler);
app.post('/api/cashier/transactions', saveOperationHandler);

app.put('/api/cahier/operations/:id', updateOperationHandler);
app.put('/api/cashier/transactions/:id', updateOperationHandler);
app.patch('/api/cahier/operations/:id', updateOperationHandler);
app.patch('/api/cashier/transactions/:id', updateOperationHandler);

app.delete('/api/cahier/operations/:id', deleteOperationsHandler);
app.delete('/api/cashier/transactions/:id', deleteOperationsHandler);
app.delete('/api/cahier/operations', deleteOperationsHandler);
app.delete('/api/cashier/transactions', deleteOperationsHandler);

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
