# Graph Report - applet  (2026-09-10)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 469 nodes · 863 edges · 24 communities (16 shown, 5 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- AuthService
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
- sales-purchases.model.ts
- UserService
- ThemeService
- DashboardManager
- vercel.json
- DashboardAdmin
- Profile
- Login
- index.js

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
- `CashierService` --references--> `SupabaseService`  [EXTRACTED]
  src/app/core/services/cashier.service.ts → src/app/core/services/supabase.service.ts
- `NavOption` --references--> `UserRole`  [EXTRACTED]
  src/app/layout/main-layout/main-layout.ts → src/app/core/models/auth.model.ts
- `createCollaboratorHandler()` --calls--> `normalizeUserRole()`  [EXTRACTED]
  src/server.ts → src/app/core/utils/role.utils.ts
- `getCollaboratorsHandler()` --calls--> `normalizeUserRole()`  [EXTRACTED]
  src/server.ts → src/app/core/utils/role.utils.ts
- `requireAdmin()` --calls--> `normalizeUserRole()`  [EXTRACTED]
  src/server.ts → src/app/core/utils/role.utils.ts

## Import Cycles
- None detected.

## Communities (24 total, 5 thin omitted)

### Community 0 - "AuthService"
Cohesion: 0.08
Nodes (41): @angular/common, @angular/core, @angular/forms, @angular/router, chart.js, vitest, authGuard(), roleGuard() (+33 more)

### Community 1 - "options"
Cohesion: 0.04
Nodes (48): architect, prefix, projectType, root, schematics, sourceRoot, build, lint (+40 more)

### Community 2 - "finance-cash.model.ts"
Cohesion: 0.05
Nodes (37): AccountChart, AccountClass, AccountType, FinancialReport, JournalEntry, JournalEntryLine, JournalType, ReportStatus (+29 more)

### Community 3 - "package.json"
Cohesion: 0.05
Nodes (39): name, private, scripts, build, dev, lint, ng, serve:ssr:app (+31 more)

### Community 4 - "CashierService"
Cohesion: 0.14
Nodes (3): CashierTransaction, CashierService, Injectable

### Community 5 - "CashierManagement"
Cohesion: 0.12
Nodes (3): CashierManagement, Component, ViewChild

### Community 6 - "MainLayout"
Cohesion: 0.11
Nodes (6): UserRole, HrManagement, Component, MainLayout, NavOption, Component

### Community 7 - "server.ts"
Cohesion: 0.18
Nodes (17): normalizeUserRole(), angularApp, app, browserDistFolder, createCollaboratorHandler(), deleteCollaboratorHandler(), deleteOperationsHandler(), getCollaboratorsHandler() (+9 more)

### Community 8 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @angular/cdk, @angular/common, @angular/compiler, @angular/core, @angular/forms, @angular/material, @angular/platform-browser (+12 more)

### Community 9 - "app.config.server.ts"
Cohesion: 0.19
Nodes (9): @angular/platform-browser, @angular/ssr, App, appConfig, config, serverConfig, routes, serverRoutes (+1 more)

### Community 10 - "UsersManagement"
Cohesion: 0.19
Nodes (6): RFC-4122, generateSecurePassword(), generateSecureUUID(), getRandomIndex(), Component, UsersManagement

### Community 11 - "devDependencies"
Cohesion: 0.12
Nodes (16): devDependencies, @angular/build, @angular/cli, @angular/compiler-cli, angular-eslint, cross-env, eslint, jsdom (+8 more)

### Community 13 - "sales-purchases.model.ts"
Cohesion: 0.17
Nodes (11): Client, Invoice, InvoiceItem, InvoiceStatus, OrderStatus, PaymentMethod, PurchaseOrder, PurchaseOrderItem (+3 more)

### Community 15 - "ThemeService"
Cohesion: 0.22
Nodes (3): AppTheme, ThemeService, Injectable

### Community 16 - "DashboardManager"
Cohesion: 0.27
Nodes (3): DashboardManager, Component, ViewChild

### Community 17 - "vercel.json"
Cohesion: 0.25
Nodes (7): includeFiles, buildCommand, functions, api/index.js, outputDirectory, rewrites, $schema

## Knowledge Gaps
- **177 isolated node(s):** `AuthSession`, `NavMenuItem`, `RoleDefinition`, `CashierOperationType`, `CashierDbRow` (+172 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 239 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@angular/core` connect `AuthService` to `app.config.server.ts`, `package.json`, `ThemeService`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `CashierService` connect `CashierService` to `AuthService`?**
  _High betweenness centrality (0.087) - this node is a cross-community bridge._
- **Why does `CashierManagement` connect `CashierManagement` to `AuthService`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **What connects `AuthSession`, `NavMenuItem`, `RoleDefinition` to the rest of the system?**
  _177 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `AuthService` be split into smaller, more focused modules?**
  _Cohesion score 0.07606019151846785 - nodes in this community are weakly interconnected._
- **Should `options` be split into smaller, more focused modules?**
  _Cohesion score 0.04251700680272109 - nodes in this community are weakly interconnected._
- **Should `finance-cash.model.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._