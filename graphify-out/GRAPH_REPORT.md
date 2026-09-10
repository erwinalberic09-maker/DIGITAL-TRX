# Graph Report - applet  (2026-09-10)

## Corpus Check
- 74 files · ~33,119 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 474 nodes · 865 edges · 23 communities (16 shown, 4 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- auth.service.ts
- options
- finance-cash.model.ts
- package.json
- CashierService
- CashierManagement
- MainLayout
- server.ts
- dependencies
- app.config.server.ts
- UsersManagement
- devDependencies
- AuthService
- hr.model.ts
- auth.model.ts
- rules/graphify.md
- DashboardManager
- vercel.json
- workflows/graphify.md
- GEMINI.md

## God Nodes (most connected - your core abstractions)
1. `AuthService` - 44 edges
2. `CashierService` - 36 edges
3. `@angular/core` - 29 edges
4. `CashierManagement` - 26 edges
5. `SupabaseService` - 23 edges
6. `UserService` - 22 edges
7. `@angular/router` - 21 edges
8. `MainLayout` - 20 edges
9. `UserProfile` - 19 edges
10. `CashierTransaction` - 14 edges

## Surprising Connections (you probably didn't know these)
- `NavOption` --references--> `UserRole`  [EXTRACTED]
  src/app/layout/main-layout/main-layout.ts → src/app/core/models/auth.model.ts
- `CashierService` --references--> `SupabaseService`  [EXTRACTED]
  src/app/core/services/cashier.service.ts → src/app/core/services/supabase.service.ts
- `createCollaboratorHandler()` --calls--> `normalizeUserRole()`  [EXTRACTED]
  src/server.ts → src/app/core/utils/role.utils.ts
- `getCollaboratorsHandler()` --calls--> `normalizeUserRole()`  [EXTRACTED]
  src/server.ts → src/app/core/utils/role.utils.ts
- `requireAdmin()` --calls--> `normalizeUserRole()`  [EXTRACTED]
  src/server.ts → src/app/core/utils/role.utils.ts

## Import Cycles
- None detected.

## Communities (23 total, 4 thin omitted)

### Community 0 - "auth.service.ts"
Cohesion: 0.09
Nodes (29): @angular/common, @angular/core, @angular/router, chart.js, vitest, routes, authGuard(), roleGuard() (+21 more)

### Community 1 - "options"
Cohesion: 0.04
Nodes (48): architect, prefix, projectType, root, schematics, sourceRoot, build, lint (+40 more)

### Community 2 - "finance-cash.model.ts"
Cohesion: 0.05
Nodes (38): AccountChart, AccountClass, AccountType, FinancialReport, JournalEntry, JournalEntryLine, JournalType, ReportStatus (+30 more)

### Community 3 - "package.json"
Cohesion: 0.06
Nodes (35): name, private, scripts, build, dev, lint, ng, serve:ssr:app (+27 more)

### Community 5 - "CashierManagement"
Cohesion: 0.12
Nodes (3): CashierManagement, Component, ViewChild

### Community 6 - "MainLayout"
Cohesion: 0.08
Nodes (7): UserRole, AppTheme, ThemeService, Injectable, MainLayout, NavOption, Component

### Community 7 - "server.ts"
Cohesion: 0.15
Nodes (19): dotenv, express, normalizeUserRole(), angularApp, app, browserDistFolder, createCollaboratorHandler(), deleteCollaboratorHandler() (+11 more)

### Community 8 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @angular/cdk, @angular/common, @angular/compiler, @angular/core, @angular/forms, @angular/material, @angular/platform-browser (+12 more)

### Community 9 - "app.config.server.ts"
Cohesion: 0.21
Nodes (8): @angular/platform-browser, @angular/ssr, App, appConfig, config, serverConfig, serverRoutes, Component

### Community 10 - "UsersManagement"
Cohesion: 0.21
Nodes (6): RFC-4122, generateSecurePassword(), generateSecureUUID(), getRandomIndex(), Component, UsersManagement

### Community 11 - "devDependencies"
Cohesion: 0.12
Nodes (16): devDependencies, @angular/build, @angular/cli, @angular/compiler-cli, angular-eslint, cross-env, eslint, jsdom (+8 more)

### Community 12 - "AuthService"
Cohesion: 0.25
Nodes (3): UserProfile, AuthService, Injectable

### Community 13 - "hr.model.ts"
Cohesion: 0.18
Nodes (10): Attendance, AttendanceStatus, Department, Employee, EmployeeContractType, LeaveRequest, LeaveRequestStatus, LeaveType (+2 more)

### Community 14 - "auth.model.ts"
Cohesion: 0.07
Nodes (23): @angular/forms, @supabase/ssr, @supabase/supabase-js, AuthSession, CreateUserPayload, LoginCredentials, NavMenuItem, ROLE_DEFINITIONS (+15 more)

### Community 16 - "DashboardManager"
Cohesion: 0.27
Nodes (3): DashboardManager, Component, ViewChild

### Community 17 - "vercel.json"
Cohesion: 0.25
Nodes (7): includeFiles, buildCommand, functions, api/index.js, outputDirectory, rewrites, $schema

## Knowledge Gaps
- **179 isolated node(s):** `$schema`, `version`, `packageManager`, `schematicCollections`, `analytics` (+174 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 244 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@angular/core` connect `auth.service.ts` to `app.config.server.ts`, `package.json`, `auth.model.ts`, `MainLayout`?**
  _High betweenness centrality (0.131) - this node is a cross-community bridge._
- **Why does `CashierService` connect `CashierService` to `auth.service.ts`, `auth.model.ts`, `MainLayout`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Why does `CashierManagement` connect `CashierManagement` to `auth.service.ts`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **What connects `$schema`, `version`, `packageManager` to the rest of the system?**
  _179 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `auth.service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08766233766233766 - nodes in this community are weakly interconnected._
- **Should `options` be split into smaller, more focused modules?**
  _Cohesion score 0.04251700680272109 - nodes in this community are weakly interconnected._
- **Should `finance-cash.model.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.046511627906976744 - nodes in this community are weakly interconnected._