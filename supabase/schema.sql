-- ==============================================================================
-- SCHEMA SUPABASE : GESTION DE CAISSE & UTILISATEURS (TRANSIMEX)
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. ENUMÉRATIONS & TYPES
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'manager', 'caissiere', 'caissier', 'rh', 'employe', 'client', 'partenaire');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. TABLE DES PROFILS UTILISATEURS
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    first_name TEXT,
    last_name TEXT,
    role user_role DEFAULT 'employe'::user_role NOT NULL,
    department TEXT DEFAULT 'Services Généraux',
    phone TEXT,
    is_active BOOLEAN DEFAULT true NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Activation de RLS sur profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Politiques RLS sur profiles (optimisées avec (SELECT auth.uid()))
DROP POLICY IF EXISTS "Les profils sont consultables par tous les utilisateurs authentifiés" ON public.profiles;
CREATE POLICY "Les profils sont consultables par tous les utilisateurs authentifiés"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "Les utilisateurs peuvent modifier leur propre profil" ON public.profiles;
CREATE POLICY "Les utilisateurs peuvent modifier leur propre profil"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (id = (SELECT auth.uid()))
    WITH CHECK (
        id = (SELECT auth.uid())
        -- Empêche l'escalade de privilège : un utilisateur ne peut pas modifier son propre rôle
        AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    );

-- 4. TABLE DES TRANSACTIONS DE CAISSE
CREATE TABLE IF NOT EXISTS public.cashier_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    libelle TEXT NOT NULL,
    type_transaction TEXT NOT NULL,
    type_description TEXT,
    category TEXT NOT NULL CHECK (category IN ('entree', 'sortie')),
    matricule_vehicule TEXT,
    first_name TEXT,
    employee TEXT,
    quantity NUMERIC DEFAULT 1,
    montant NUMERIC NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Activation de RLS sur cashier_transactions
ALTER TABLE public.cashier_transactions ENABLE ROW LEVEL SECURITY;

-- Index de clés étrangères et performances (recommandations Advisors Supabase)
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_created_by ON public.cashier_transactions(created_by);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_date ON public.cashier_transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_category ON public.cashier_transactions(category);

-- 5. POLITIQUES RLS SUR CASHIER_TRANSACTIONS
DROP POLICY IF EXISTS "cashier_transactions_select_policy" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_select_policy"
    ON public.cashier_transactions
    FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "cashier_transactions_insert_policy" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_insert_policy"
    ON public.cashier_transactions
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS "cashier_transactions_update_policy" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_update_policy"
    ON public.cashier_transactions
    FOR UPDATE
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "cashier_transactions_delete_policy" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_delete_policy"
    ON public.cashier_transactions
    FOR DELETE
    TO authenticated
    USING (true);

-- 6. TRIGGER DE SYNCHRONISATION UTILISATEUR SÉCURISÉ (SECURITY DEFINER + search_path)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public
AS $$
DECLARE
    assigned_role user_role := 'employe'::user_role;
    raw_role text;
BEGIN
    raw_role := lower(COALESCE(new.raw_user_meta_data->>'role', ''));
    -- Interdire l'auto-attribution du rôle admin depuis le client public
    IF raw_role IN ('caissier', 'caissiere', 'employe', 'client', 'partenaire') THEN
        assigned_role := raw_role::user_role;
    END IF;

    INSERT INTO public.profiles (id, email, first_name, last_name, role)
    VALUES (
        new.id,
        new.email,
        COALESCE(new.raw_user_meta_data->>'first_name', ''),
        COALESCE(new.raw_user_meta_data->>'last_name', ''),
        assigned_role
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- Révocation des privilèges d'exécution publique (Anon) sur la fonction SECURITY DEFINER
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
