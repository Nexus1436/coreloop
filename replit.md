# Interloop by Signal

## Overview

Interloop is a calm, meditative web application that provides a space for reflection, speaking, and listening. It features two interaction modes:

- **View A (Voice Mode):** A visually immersive experience centered around a breathing/pulsing orb animation inside a logo, designed to feel biological and organic. Users interact through voice.
- **View B (Text Mode):** A text-first chat interface for users who prefer typing, with a scrollable message thread and text input.

The app has a distinctive visual identity: piano-lacquer black background, charcoal/graphite text, and a carefully specified breath-pulse animation that follows precise timing and opacity rules. The design philosophy prioritizes calm, biological-feeling interactions over mechanical or status-indicator aesthetics.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework:** React with TypeScript
- **Build Tool:** Vite with HMR support
- **Routing:** Wouter (lightweight React router)
- **State Management:** TanStack React Query for server state
- **UI Components:** shadcn/ui component library (new-york style) built on Radix UI primitives
- **Styling:** Tailwind CSS v4 with CSS variables for theming
- **Animation:** Framer Motion for the breath/pulse orb animation and UI transitions
- **Fonts:** Geist and Geist Mono from Google Fonts

The frontend lives in `client/src/` with path aliases:
- `@/*` → `client/src/*`
- `@shared/*` → `shared/*`
- `@assets` → `attached_assets/`

### Backend Architecture
- **Runtime:** Node.js with Express 5
- **Language:** TypeScript, executed via tsx
- **API Pattern:** RESTful with `/api/` prefix
- **Development:** Vite dev server middleware integrated with Express for HMR
- **Production:** Client built to `dist/public/`, server bundled to `dist/index.cjs` via esbuild

The server has a clean separation:
- `server/index.ts` — Express app setup, logging middleware
- `server/routes.ts` — API route registration (currently just a health check)
- `server/storage.ts` — Storage interface (currently in-memory, minimal)
- `server/vite.ts` — Vite dev server integration
- `server/static.ts` — Static file serving for production builds

### Data Layer
- **ORM:** Drizzle ORM configured for PostgreSQL
- **Schema:** Defined in `shared/schema.ts` (currently empty, just imports Zod)
- **Migrations:** Output to `./migrations/` directory
- **Validation:** Zod for schema validation, drizzle-zod for integration
- **Database:** PostgreSQL, connected via `DATABASE_URL` environment variable
- **Session Store:** connect-pg-simple available for session persistence

Run `npm run db:push` to push schema changes to the database.

### Shared Code
The `shared/` directory contains code shared between client and server, primarily the database schema and validation types.

### Build Process
- `npm run dev` — Starts development server with Vite HMR
- `npm run build` — Builds client (Vite) and server (esbuild) to `dist/`
- `npm run start` — Runs production build
- `npm run db:push` — Pushes Drizzle schema to PostgreSQL

### Key Design Specifications
The `attached_assets/` directory contains detailed spec documents for:
- Breath/pulse animation timing (8.5-12s cycles with specific inhale/exhale behaviors)
- Orb visual behavior (never a hard circle, fog-like, inverse opacity-to-size relationship)
- Logo opacity rules (fixed, never reactive)
- View B text mode layout and interaction patterns

## External Dependencies

### Database
- **PostgreSQL** — Primary database, required via `DATABASE_URL` environment variable
- **Drizzle ORM** — Database toolkit with migration support
- **connect-pg-simple** — PostgreSQL session store (available but not yet wired up)

### Frontend Libraries
- **Radix UI** — Full suite of accessible, unstyled UI primitives
- **Framer Motion** — Animation library for the breath/pulse effect and transitions
- **TanStack React Query** — Server state management and data fetching
- **Embla Carousel** — Carousel component
- **Recharts** — Charting library (available via shadcn chart component)
- **cmdk** — Command palette component
- **react-day-picker** — Calendar/date picker
- **vaul** — Drawer component
- **react-resizable-panels** — Resizable panel layout

### Replit-Specific
- **@replit/vite-plugin-runtime-error-modal** — Runtime error overlay in development
- **@replit/vite-plugin-cartographer** — Development tooling (dev only)
- **@replit/vite-plugin-dev-banner** — Development banner (dev only)
- **vite-plugin-meta-images** — Custom plugin for OpenGraph meta tag management