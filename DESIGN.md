# Design System: Kestrel-IT ("Precision Enterprise")

## 1. Visual Theme & Atmosphere

- **Design Read:** Enterprise IT Asset Management (ITAM) cockpit built for IT Operations, SecOps, and System Administrators, with a calm **Precision Enterprise** language inspired by Linear, Vercel, and Raycast. Engineered with Angular 19 Standalone + Signals, hairline borders, high-density monospace telemetry, and zero decorative clutter.
- **Taste Dials:**
  - `VISUAL_DENSITY: 8` (*Cockpit Dense* — hardware asset tags, serial numbers, MAC/IP addresses, license keys, currencies, and audit timestamps are always aligned using `tabular-nums` monospace).
  - `DESIGN_VARIANCE: 5` (*Offset Asymmetric* — split-screen asymmetric architecture on Login and Setup Wizard; left collapsible sidebar + high-density operational cockpit workspace).
  - `MOTION_INTENSITY: 5` (*Fluid CSS* — spring-eased transitions `cubic-bezier(0.22, 1, 0.36, 1)` strictly animated on `transform` and `opacity`; tactile active press `scale(0.985)`).

---

## 2. Color Palette & Semantic Roles (Dual Theme)

### Light Mode (Default — Crisp Architectural Zinc)
- **Canvas Background (`--kestrel-canvas`):** `#FAFAFA` (`Zinc-50`) — Primary page backdrop
- **Elevated Surface (`--kestrel-surface`):** `#FFFFFF` — Cards, DataGrid cells, form panels, drawer surface
- **Subtle Surface (`--kestrel-surface-subtle`):** `#F4F4F5` (`Zinc-100`) — Hover states, table headers, keyboard shortcut pills
- **Primary Ink (`--kestrel-ink`):** `#18181B` (`Zinc-900`) — Primary headings, table values, button contrast ink (pure `#000000` is banned)
- **Muted Steel (`--kestrel-muted`):** `#71717A` (`Zinc-500`) — Secondary metadata, field hints, table subtitles
- **Whisper Border (`--kestrel-border`):** `#E4E4E7` (`Zinc-200`) — 1px structural borders, table dividers, sidebar seams
- **Strong Border (`--kestrel-border-strong`):** `#D4D4D8` (`Zinc-300`) — Input borders and interactive hover rings

### Dark Mode (`[data-theme="dark"]` / `.dark` — Obsidian Zinc-950)
- **Canvas Background (`--kestrel-canvas`):** `#09090B` (`Zinc-950`) — Primary dark backdrop (pure `#000000` is banned)
- **Elevated Surface (`--kestrel-surface`):** `#18181B` (`Zinc-900`) — Cards, DataGrid panels, drawers
- **Subtle Surface (`--kestrel-surface-subtle`):** `#27272A` (`Zinc-800`) — Row hover, keycaps, input wells
- **Primary Ink (`--kestrel-ink`):** `#F4F4F5` (`Zinc-100`) — Crisp legible light ink
- **Muted Steel (`--kestrel-muted`):** `#A1A1AA` (`Zinc-400`) — Secondary metadata matching WCAG AA contrast
- **Whisper Border (`--kestrel-border`):** `rgba(255, 255, 255, 0.09)` — Hairline structural seams
- **Strong Border (`--kestrel-border-strong`):** `rgba(255, 255, 255, 0.16)` — Input outlines and elevated drawers

### Single Primary Accent & Semantic ITAM Status Tokens
- **Kestrel Teal (`--kestrel-accent`):** `#0D9488` (Light) / `#14B8A6` (Dark) — Single primary CTA fill, active nav indicator, focus ring accent (saturation < 80%, zero purple/neon gradients)
- **Kestrel Teal Hover (`--kestrel-accent-hover`):** `#0F766E` (Light) / `#2DD4BF` (Dark)
- **Focus Ring (`--kestrel-ring`):** `rgba(13, 148, 136, 0.28)`
- **Semantic ITAM Statuses (`StatusMetaType`):**
  - `deployable` (*Ready to Deploy*): Emerald `#10B981`
  - `deployed` (*Assigned / Checked Out*): Sky `#0284C7`
  - `pending` (*Pending / In Maintenance*): Amber `#D97706`
  - `undeployable` (*Broken / Overdue / Lost*): Crimson `#E11D48`
  - `archived` (*Archived / Retired*): Zinc `#71717A`

---

## 3. Typography Rules

- **UI & Display Sans (`--kestrel-font-sans`):** `'Geist'`, `'Plus Jakarta Sans'`, `-apple-system`, `BlinkMacSystemFont`, `'Segoe UI'`, sans-serif.
  - Controlled tight tracking (`-0.02em`) on H1/H2 page titles (`1.25rem`–`1.75rem`, weight `600`–`700`).
  - Body text minimum `0.875rem` (`14px`) with relaxed line height (`1.5`).
- **Technical Monospace (`--kestrel-font-mono`):** `'JetBrains Mono'`, `'Geist Mono'`, `ui-monospace`, `SFMono-Regular`, monospace.
  - Mandatory `font-variant-numeric: tabular-nums` for all numeric KPIs, `asset_tag`, `serial`, MAC/IP addresses, TOTP verification codes, PAT tokens (`kst_...`), ISO timestamps, quantities, and currency amounts.
- **Explicit Font Bans:** `Inter`, `Roboto`, generic serifs (`Times New Roman`, `Georgia`, `Garamond`), and decorative/display serifs are banned across the entire SPA.

---

## 4. Component Stylings & Primitives

- **Buttons (`.k-btn`):** Compact `36px`–`40px` height (`min-height: 44px` on touch/auth primary CTAs), single-line label, crisp `8px` radius, tactile `transform: scale(0.985)` on `:active`. Variants: `.k-btn-primary` (Kestrel Teal fill), `.k-btn-secondary` (surface + 1px border), `.k-btn-ghost`, `.k-btn-danger`.
- **Surface Containers & Cards (`.k-card`):** `1px solid var(--kestrel-border)` with `10px` radius and minimal background-tinted elevation; never stacked nested cards inside cards. In dense inventory screens, divide rows with 1px hairlines rather than heavy shadows.
- **Forms & Inputs (`.k-label`, `.k-input`, `.k-error`):** Label positioned strictly *above* the input (never floating labels or placeholder-as-label), optional helper text, inline error message below with minimum WCAG AA 4.5:1 contrast.
- **DataGrid (`<kestrel-data-grid>`):** Server-side sort indicators, search input, company-aware bulk selection action bar, monospace alignment for tags/serials/currencies, skeleton shimmer loading bars matching row geometry, composed empty states, and action buttons gated strictly by `row.available_actions`.
- **Async Select (`<kestrel-async-select>`):** Company-scoped FMCS selectlist control implementing `ControlValueAccessor` with inline `+ New` quick-create trigger.
- **Slide-Over Drawer (`<kestrel-slide-drawer>`):** Right-anchored overlay panel (`Esc` & backdrop dismissible) for Checkout, Checkin, Audit, and Quick-Create flows without losing DataGrid filter/page state.
- **Command Palette (`<kestrel-command-palette>`):** Keyboard-first (`⌘K` / `Ctrl+K`) global navigation and quick actions filtered by `AuthStore.can(...)`.

---

## 5. Layout Principles & Responsive Discipline

- **Authenticated Shell (`AppShellComponent`):** Collapsible left navigation rail (`248px` expanded / `68px` collapsed) grouped by domain (`Overview`, `Inventory`, `People & Org`, `Operations`, `Admin`), sticky topbar (`56px`) with breadcrumbs, active FMCS company scope badge, `⌘K` trigger, Light/Dark switcher (`ThemeStore`), and mobile menu collapse below `768px`.
- **Auth & Setup Split Layout:** `min-height: 100dvh` (never `100vh`) asymmetric two-column layout (`5fr / 7fr`) collapsing cleanly to single column below `768px` with zero horizontal overflow.

---

## 6. Motion & Anti-Patterns (Banned)

- **Motion:** Animate exclusively `transform` and `opacity` with `cubic-bezier(0.22, 1, 0.36, 1)` and respect `@media (prefers-reduced-motion: reduce)`. Never use circular spinners where skeleton bars belong.
- **Strict Bans:**
  - Never use pure `#000000` backgrounds or pure black drop shadows on light mode.
  - Never use AI purple/violet/indigo gradients or glowing neon shadows.
  - Never use emojis anywhere in navigation, table headers, badges, or code markup.
  - Never use `Inter` font or serif typography.
  - Never mix conflicting icon stroke styles; use uniform `1.5px` clean vector strokes.
