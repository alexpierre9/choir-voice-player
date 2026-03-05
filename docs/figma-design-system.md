# Figma Design System Integration Guide

Rules and patterns for translating Figma designs into this codebase using the Figma MCP.

---

## 1. Design Tokens

### Color System

Tokens are defined as CSS custom properties in `client/src/index.css` using a Tailwind CSS v4 `@theme` block. **Map Figma variables to these tokens — do not use raw hex values.**

**Semantic tokens (light / dark):**

| Token | Light value | Dark value | Usage |
|---|---|---|---|
| `--primary` | `blue-700` | `blue-700` | Primary actions, links |
| `--primary-foreground` | `blue-50` | `blue-50` | Text on primary bg |
| `--secondary` | `oklch(0.98 0.001 286)` | `oklch(0.27 0.006 286)` | Secondary surfaces |
| `--muted` | `oklch(0.967 0.001 286)` | `oklch(0.27 0.006 286)` | Muted backgrounds |
| `--accent` | `oklch(0.967 0.001 286)` | `oklch(0.27 0.006 286)` | Hover/focus accents |
| `--destructive` | `oklch(0.577 0.245 27)` | `oklch(0.704 0.191 22)` | Errors, delete actions |
| `--success` | `green-600` | `green-600` | Success states |
| `--warning` | `amber-600` | `amber-600` | Warning states |
| `--info` | `blue-600` | `blue-600` | Info states |
| `--background` | `oklch(1 0 0)` | `oklch(0.141 0.005 286)` | Page background |
| `--foreground` | `oklch(0.235 0.015 65)` | `oklch(0.85 0.005 65)` | Default text |
| `--border` | neutral light | neutral dark | Borders |
| `--ring` | blue-based | blue-based | Focus rings |

**Domain-specific voice colors** (defined in `client/src/lib/voiceColors.ts`):

```typescript
soprano: { border: "border-pink-300",   bg: "bg-pink-100",   dot: "bg-pink-400"   }
alto:    { border: "border-purple-300", bg: "bg-purple-100", dot: "bg-purple-400" }
tenor:   { border: "border-blue-300",   bg: "bg-blue-100",   dot: "bg-blue-400"   }
bass:    { border: "border-green-300",  bg: "bg-green-100",  dot: "bg-green-400"  }
other:   { border: "border-gray-300",   bg: "bg-gray-100",   dot: "bg-gray-400"   }
```

When a Figma component uses voice-specific colors, import from `voiceColors.ts` rather than hardcoding.

### Border Radius

```css
--radius-sm:  calc(var(--radius) - 4px)  /* ~6px  */
--radius-md:  calc(var(--radius) - 2px)  /* ~8px  */
--radius-lg:  var(--radius)               /* ~10px */
--radius-xl:  calc(var(--radius) + 4px)  /* ~14px */
```

Tailwind utilities: `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-full`.

### Typography

No custom typeface — uses system font stack via Tailwind defaults. Map Figma text styles to Tailwind utilities:

| Figma style | Tailwind classes |
|---|---|
| Display / Hero | `text-4xl font-bold tracking-tight` |
| H1 | `text-3xl font-bold` |
| H2 | `text-2xl font-semibold` |
| H3 | `text-xl font-semibold` |
| Body | `text-sm` (default) / `text-base` |
| Small / Caption | `text-xs text-muted-foreground` |
| Label | `text-sm font-medium` |

### Spacing

Tailwind 4-unit spacing scale (`4px` base). Use standard utilities (`p-4`, `gap-6`, etc.). The `.container` utility applies:
- Mobile: `px-4`
- sm+: `px-6`
- lg+: `px-8` with `max-w-5xl`

---

## 2. Component Library

### Source

All UI primitives are **shadcn/ui (New York style)** located in `client/src/components/ui/`. They are built on **Radix UI** primitives and use **class-variance-authority (CVA)** for variants.

**Do not create new primitive components** (Button, Input, Card, etc.) — always use and extend the existing ones in `ui/`.

### shadcn/ui Config (`components.json`)

```json
{
  "style": "new-york",
  "tailwind": { "baseColor": "neutral", "cssVariables": true },
  "aliases": {
    "ui": "@/components/ui",
    "utils": "@/lib/utils"
  }
}
```

### Key Components Available

| Component | File | Notes |
|---|---|---|
| Button | `ui/button.tsx` | Variants: default, destructive, outline, secondary, ghost, link. Sizes: sm, default, lg, icon, icon-sm, icon-lg |
| Card | `ui/card.tsx` | Compound: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` |
| Input | `ui/input.tsx` | Standard text input |
| Label | `ui/label.tsx` | Form labels |
| Badge | `ui/badge.tsx` | Status indicators |
| Dialog | `ui/dialog.tsx` | Modal dialogs |
| Dropdown | `ui/dropdown-menu.tsx` | Context menus |
| Select | `ui/select.tsx` | Form selects |
| Tabs | `ui/tabs.tsx` | Tab navigation |
| Toast | `ui/sonner.tsx` | Notifications via Sonner |
| Skeleton | `ui/skeleton.tsx` | Loading states |
| Progress | `ui/progress.tsx` | Progress bars |
| Slider | `ui/slider.tsx` | Range inputs |
| Switch | `ui/switch.tsx` | Toggle switches |
| Separator | `ui/separator.tsx` | Dividers |
| Tooltip | `ui/tooltip.tsx` | Hover tooltips |
| Alert | `ui/alert.tsx` | Alert messages |

### Button Pattern

```tsx
import { Button } from "@/components/ui/button";

// Primary action
<Button>Save</Button>

// Destructive
<Button variant="destructive">Delete</Button>

// Icon button
<Button variant="ghost" size="icon">
  <Play className="h-4 w-4" />
</Button>
```

### Card Pattern

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardDescription>Subtitle or helper text</CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    {/* Content */}
  </CardContent>
</Card>
```

### cn Utility

Always merge class names with the `cn` utility from `@/lib/utils`:

```tsx
import { cn } from "@/lib/utils";

<div className={cn("base-classes", conditional && "extra-class", className)} />
```

---

## 3. Frameworks & Libraries

| Layer | Technology | Version |
|---|---|---|
| UI Framework | React | 19 |
| Build Tool | Vite | 7 |
| Styling | Tailwind CSS | 4.x |
| Component Base | shadcn/ui (New York) | latest |
| Primitives | Radix UI | latest |
| Variant System | class-variance-authority | 0.7 |
| Icons | lucide-react | 0.453 |
| Routing | Wouter | — |
| Data Fetching | TanStack Query + tRPC | — |
| Animation | tw-animate-css | — |

---

## 4. Icon System

**Library:** `lucide-react`

**Import pattern:**
```tsx
import { Music, Play, Pause, Upload, ChevronDown } from "lucide-react";

// Usage with Tailwind sizing
<Music className="h-8 w-8 text-blue-600 dark:text-blue-400" />
<Play className="h-5 w-5" />
<ChevronDown className="h-4 w-4" />
```

**Standard sizes:**
- `h-4 w-4` — small (inside buttons, lists)
- `h-5 w-5` — medium (standalone inline icons)
- `h-6 w-6` — medium-large
- `h-8 w-8` — large (logo/hero icons)

**Naming:** Use the exact Lucide icon name. Browse available icons at [lucide.dev](https://lucide.dev). When a Figma design uses a custom icon not in Lucide, export it as SVG and place it in `client/src/assets/`.

---

## 5. Styling Approach

### Methodology

**Tailwind CSS utility classes** — no CSS Modules, no Styled Components, no BEM. All styling is done via Tailwind utilities directly in JSX.

Global styles live in `client/src/index.css` only. Do not create per-component CSS files.

### Dark Mode

Dark mode uses the `.dark` class on `<html>` (managed by `client/src/contexts/ThemeContext.tsx`).

When implementing Figma components, always add dark mode variants:

```tsx
// Correct
<div className="bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">

// Use semantic tokens when possible (auto-handle dark mode)
<div className="bg-background text-foreground">
```

### Responsive Design

Mobile-first with standard Tailwind breakpoints:

| Breakpoint | Min-width | Tailwind prefix |
|---|---|---|
| Mobile | 0px | (no prefix) |
| sm | 640px | `sm:` |
| md | 768px | `md:` |
| lg | 1024px | `lg:` |
| xl | 1280px | `xl:` |

Typical responsive pattern from the codebase:
```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
```

### Background Gradients

The app uses gradient backgrounds on page-level containers:
```tsx
// Page background pattern
<div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
```

### Animation

Use `tw-animate-css` utilities for transitions. Prefer Tailwind's built-in `transition`, `duration-*`, `ease-*` for simple hover/focus states.

---

## 6. Asset Management

**Path aliases (vite.config.ts):**
```
@/       → client/src/
@shared/ → shared/
@assets/ → attached_assets/
```

**Static assets:** Place in `client/public/` for direct URL access, or `client/src/assets/` for Vite-processed imports.

**Images in components:**
```tsx
import logo from "@/assets/logo.png";
<img src={logo} alt="Logo" />
```

**No CDN configured** — assets are served from the Express server. In production, files are served via local filesystem or Forge cloud storage (for music files, not UI assets).

---

## 7. Project Structure

```
client/src/
├── components/
│   ├── ui/              # shadcn/ui primitives (54 components — DO NOT recreate)
│   ├── Header.tsx       # App shell header
│   ├── MidiPlayer.tsx   # Domain-specific playback UI
│   └── ErrorBoundary.tsx
├── contexts/
│   └── ThemeContext.tsx  # Theme provider (dark/light)
├── hooks/               # Custom React hooks
├── lib/
│   ├── utils.ts         # cn() helper
│   ├── voiceColors.ts   # SATB color tokens
│   └── trpc.ts          # API client
├── pages/               # Route-level components (Wouter)
│   ├── Home.tsx
│   ├── Login.tsx
│   ├── Upload.tsx
│   ├── SheetDetail.tsx
│   ├── Settings.tsx
│   └── NotFound.tsx
└── index.css            # Tailwind v4 + CSS custom properties
```

---

## 8. Figma-to-Code Workflow

When the `get_design_context` tool returns a component:

1. **Check for existing components first.** If the design uses a Card, Button, Input, etc., use the component from `client/src/components/ui/` — do not generate a new one.

2. **Map colors to tokens.** Replace any raw hex/rgba from Figma with the closest semantic CSS variable (`bg-primary`, `text-muted-foreground`, `border`, etc.) or Tailwind utility (`bg-blue-600`, `text-gray-500`).

3. **Map radius to tokens.** Use `rounded-sm/md/lg/xl` instead of arbitrary values.

4. **Use Lucide icons.** Match Figma icons to their Lucide equivalents. Import named from `lucide-react`.

5. **Dark mode.** Add `dark:` variants for every color, background, and border class.

6. **Add `cn()` wrapping** if the component accepts a `className` prop.

7. **Responsive.** Default to mobile-first. Add `md:` / `lg:` breakpoints for layout changes.

8. **Never add raw `<style>` tags** or CSS module files.

### Example: Figma card → code

```tsx
// From Figma: Card with icon, title, description
import { Card, CardContent } from "@/components/ui/card";
import { Music } from "lucide-react";
import { cn } from "@/lib/utils";

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  className?: string;
}

export function FeatureCard({ icon, title, description, className }: FeatureCardProps) {
  return (
    <Card className={cn("p-6 text-center", className)}>
      <CardContent className="flex flex-col items-center gap-4 p-0">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
          {icon}
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}
```
