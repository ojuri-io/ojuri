# Ojuri Brand Guide

This document is the canonical reference for how Ojuri presents itself — voice,
visual identity, and the rules that hold them together. Contributors building
docs, marketing surfaces, or UI work that touches the brand should read it
first.

The brand is intentionally restrained. Monotone palette, generous typography,
no decorative chrome. The witness framing in the name — Ojuri (Yoruba: *ojúrí*,
"the seeing eye") — gives the brand its posture: impartial, considered, letting
evidence speak. Visual restraint mirrors that posture.

---

## 1. Foundation

**Name.** Ojuri (Yoruba: *ojúrí*) — "the seeing eye." Pronounced "oh-JOO-ree."
Always sentence case in running text. Never all-caps in body copy. The brand
mark itself uses sentence case as well.

**Tagline.** *Open source fraud detection that bears witness to every
transaction.*

Use the full tagline in launch contexts, the README hero, and primary landing
surfaces. In tighter spaces, the short form is acceptable: *bears witness to
every transaction.* Do not abbreviate further — the witness frame is the
brand and must remain whole.

**Positioning.** Ojuri is the open source, self-hosted, multi-agent fraud
detection platform for fintech, payments, and e-commerce. Real-time scoring,
drift-aware retraining, LLM-powered investigation reports, operator dashboard.
MIT licensed. No SaaS lock-in.

**Audience.** Fintech engineers, ML engineers, fraud analysts, security
researchers, open source contributors. They are technically competent and
allergic to marketing voice. Address them as peers.

---

## 2. Voice & tone

### Voice attributes

1. **Precise.** Specific numbers, real names, concrete examples. *"p99 ≈ 6 ms
   uncontended, 85 ms at 16-way concurrency"* not *"blazingly fast."* Quote
   figures from [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#8-performance-characteristics),
   which is the only place they are maintained — a precise number copied
   into a second file is a number that will be wrong later.
2. **Honest.** Acknowledge limitations and trade-offs in the same paragraph as
   the strengths. The PaySim F1 disclosure in `ARCHITECTURE.md` is the model.
3. **Considered.** Each word earns its place. If a sentence can be cut without
   losing meaning, cut it.
4. **Confident, not boastful.** Make direct claims; avoid superlatives. *"Sub-200ms decisions"*
   not *"industry-leading performance."*
5. **Grounded.** Plain language wherever plain language works. Save technical
   precision for places where it adds information, not weight.

### Words to use

*Witness, attest, observe, see. Evidence, testimony, record. Decide, judge,
verdict. Self-hosted, your infrastructure. Transparent, auditable.
Production-grade.*

### Words to avoid

*Revolutionary, disruptive, game-changing.
Cutting-edge, next-generation, state-of-the-art.
Powerful, robust, scalable* (empty without specifics).
*Real-time AI-powered* (already implied).
*Solutions, leverage, synergies, delight, magic, seamless.*

### Tone by context

| Surface | Tone |
|---|---|
| README hero, landing page | Brand voice — witness framing visible, considered, editorial |
| README body, getting-started | Technical-clear — direct, scannable, code-first |
| `ARCHITECTURE.md`, per-feature docs | Technical-precise — no brand voice, references over rhetoric |
| `CONTRIBUTING.md` | Warm-direct — friendly, peer-to-peer |
| `SECURITY.md` | Serious-professional — concrete commitments, no minimisation |
| Blog posts, essays | Brand voice with editorial pacing — longer-form, generous |
| Product UI strings, error messages | Precise-helpful — no humour, no hedging |
| Commit messages | Conventional commits — direct, present tense, lowercase |

### Voice examples

**Good.** *Ojuri scores transactions in real time, learns from emerging
patterns, explains every decision in plain language, and stays under your
roof — no SaaS, no data egress, no per-call fees.*

**Bad.** *Ojuri is a revolutionary AI-powered fraud prevention platform that
empowers fintechs with cutting-edge detection capabilities.*

**Good.** *Performance numbers in this document are orientation values measured
on a single Apple Silicon developer workstation, not SLA targets — re-measure
on your own hardware before relying on them.*

**Bad.** *Ojuri delivers blazing-fast, industry-leading performance for your
mission-critical workloads.*

---

## 3. Visual identity

### 3.1 Logo

The Ojuri logo is a wordmark: the word *Ojuri* set in **Source Serif 4 Display**
at **600 weight**, sentence case, in primary ink. No symbol, no decorative
treatment.

**Specification**

- Type: Source Serif 4 Display, weight 600
- Case: Sentence case ("Ojuri" — never "OJURI" or "ojuri")
- Color: `--ink` (`#1A1612`) on cream surfaces; `--surface` (`#FAF6F0`) on ink surfaces
- Letter-spacing: optical / default kerning, no manual tracking
- Minimum size: 16px (digital) / 12pt (print)
- Clear space: minimum of the cap-height of "O" on every side

**Don't**

- Don't stretch, skew, or rotate
- Don't recolor outside the brand palette
- Don't add a stroke, shadow, glow, or outline
- Don't pair with a symbol mark (none exists, none planned for v1)
- Don't typeset in any font other than Source Serif 4
- Don't change the case

A symbol mark may be explored in a future revision — likely treating the
diacritic on "ó" as a glyph. Until that work is done and approved, the
wordmark is the entire logo system.

### 3.2 Color

Ojuri uses a single warm-grey scale. There is no traditional accent color on
brand surfaces. Hierarchy comes from weight, size, and spacing — not from
color contrast.

**The Stone scale**

| Token | Hex | Use |
|---|---|---|
| `--stone-50`  | `#FDFCFA` | Lightest cream, alt surface |
| `--stone-100` | `#FAF6F0` | **Primary surface** (default background) |
| `--stone-200` | `#F0EBE2` | Elevated surface, subtle background variation |
| `--stone-300` | `#D9D2C6` | Borders, dividers |
| `--stone-400` | `#B0A89B` | Disabled state, faint indicators |
| `--stone-500` | `#857E72` | Muted text, captions |
| `--stone-600` | `#5C564C` | Secondary text |
| `--stone-700` | `#3F3A33` | Emphasis, hover states |
| `--stone-800` | `#2A2620` | High-emphasis text on cream |
| `--stone-900` | `#1A1612` | **Primary ink** (body text, headlines) |

**Semantic tokens**

| Token | Maps to | Use |
|---|---|---|
| `--surface` | `--stone-100` | Default page background |
| `--surface-alt` | `--stone-200` | Cards, elevated areas |
| `--ink` | `--stone-900` | Primary text, headlines, logo |
| `--ink-secondary` | `--stone-600` | Body of long-form content if `--ink` feels heavy |
| `--ink-muted` | `--stone-500` | Captions, metadata, timestamps |
| `--border` | `--stone-300` | Borders, dividers, rules |
| `--border-strong` | `--stone-700` | Emphasized borders (rare) |

**Data visualization (the only exception)**

Brand surfaces never use color beyond the Stone scale. Data visualization in
the operator dashboard may use a constrained chart palette of three muted
accents, *only* for distinguishing series where the Stone scale alone is
insufficient. These accents are not part of the brand surface palette and
must not appear in the landing page, docs, or marketing.

| Chart token | Hex | Use |
|---|---|---|
| `--chart-allow` | `#5C7A5C` | Allowed / accepted transactions |
| `--chart-decline` | `#A35140` | Declined / blocked transactions |
| `--chart-review` | `#7A6F4A` | Manual review / uncertain |

All three are muted, warm, low-saturation. They sit comfortably against the
Stone scale without competing.

**Accessibility**

Primary text combinations are WCAG AAA compliant:

- `--ink` (`#1A1612`) on `--surface` (`#FAF6F0`): contrast ratio ~15.6:1
- `--ink-secondary` (`--stone-600`) on `--surface`: contrast ratio ~6.4:1 (AA)
- `--ink-muted` (`--stone-500`) on `--surface`: contrast ratio ~4.6:1 (AA large
  text only — use for captions and metadata, not body)

### 3.3 Typography

**Type families**

| Role | Family | License | Source |
|---|---|---|---|
| Display | Source Serif 4 | OFL 1.1 | [Google Fonts](https://fonts.google.com/specimen/Source+Serif+4) |
| Body | Inter | OFL 1.1 | [Google Fonts](https://fonts.google.com/specimen/Inter) |
| Code | JetBrains Mono | OFL 1.1 | [JetBrains](https://www.jetbrains.com/lp/mono/) |

All three are free, open source, and self-hostable. Do not introduce additional
families without amending this guide.

**Type ramp**

| Token | Family | Size | Line | Weight | Use |
|---|---|---|---|---|---|
| `--text-display-xl` | Display | 64px | 68px | 700 | Hero headline (rare) |
| `--text-display-lg` | Display | 48px | 56px | 600 | Page title |
| `--text-display-md` | Display | 36px | 44px | 600 | Section heading |
| `--text-display-sm` | Display | 28px | 36px | 600 | Subsection heading |
| `--text-body-xl` | Body | 22px | 32px | 400 | Lede, intro paragraph |
| `--text-body-lg` | Body | 18px | 28px | 400 | Primary long-form body |
| `--text-body-md` | Body | 16px | 24px | 400 | **Default body** |
| `--text-body-sm` | Body | 14px | 20px | 400 | Secondary body, UI |
| `--text-body-xs` | Body | 12px | 16px | 500 | Labels, captions |
| `--text-code-md` | Code | 14px | 22px | 400 | Code blocks |
| `--text-code-sm` | Code | 12px | 20px | 400 | Inline code, tables |

**Usage rules**

- Headlines always Source Serif 4. Body and UI always Inter. Code always JetBrains Mono.
- Never set display type below 24px — it loses its character. Use sans below that.
- Never set body below 14px on a primary surface. 12px only for labels and metadata.
- Generous leading. Line height is non-negotiable; the values above are
  designed to give the brand its editorial pacing.
- Letter-spacing: default for body and code; -0.02em for display sizes ≥48px
  to tighten optically; +0.05em for all-caps labels.

### 3.4 Spacing

Base unit: **4px**. All spacing is a multiple of 4.

| Token | Value |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |
| `--space-10` | 40px |
| `--space-12` | 48px |
| `--space-16` | 64px |
| `--space-20` | 80px |
| `--space-24` | 96px |
| `--space-32` | 128px |

For editorial layouts, lean generous. Section spacing on a landing page
should typically be `--space-16` or `--space-20`. Don't pack content
together — whitespace is half the design.

### 3.5 Radii

Minimal. Editorial design rewards sharp edges and trusts content.

| Token | Value | Use |
|---|---|---|
| `--radius-none` | 0 | Default — sharp edges |
| `--radius-sm` | 2px | Buttons, inputs, subtle softening |
| `--radius-md` | 4px | Cards, modals |
| `--radius-lg` | 8px | Large surfaces, images |
| `--radius-pill` | 9999px | Tags and pills only |

Never use radii larger than 8px on rectangular surfaces. Pill radius is
reserved for actual pills (status badges, tag chips).

### 3.6 Borders & shadows

Prefer borders over shadows for layering. Shadows undermine the editorial
posture; borders reinforce it.

| Token | Value | Use |
|---|---|---|
| `--border-thin` | `1px solid var(--stone-300)` | Default border |
| `--border-medium` | `1px solid var(--stone-400)` | Emphasized border |
| `--border-strong` | `1px solid var(--stone-700)` | Strong contrast (rare) |
| `--shadow-subtle` | `0 1px 2px rgba(26,22,18,0.04)` | Faint elevation (use rarely) |
| `--shadow-card` | `0 4px 12px rgba(26,22,18,0.06)` | Card elevation (sparingly) |

If you find yourself reaching for shadows to indicate hierarchy, try a border
or a subtle background shift first.

### 3.7 Iconography

For v1.0, Ojuri uses **Lucide icons** at default stroke (1.5px) in `--ink` or
`--ink-secondary`. No custom icon set. Lucide is OFL-licensed, well-maintained,
visually quiet — appropriate to the brand.

Don't use filled icons. Don't use icons larger than 24px in body content.
Don't combine icon sets.

---

## 4. Application

### 4.1 Brand mark in context

The Ojuri wordmark appears:

- Top-left of the landing page navigation
- Top of every `docs/` page (via the docs theme, when built)
- In the Sentinel dashboard sidebar header
- In the GitHub org profile README
- In social cards and OG images

It does **not** appear:

- In email signatures of contributors (use plain text)
- As a watermark or footer decoration
- Inside body text (write "Ojuri" as plain text)

### 4.2 README presence

The README hero uses the tagline at `--text-display-md` or larger when rendered
in custom typography. Within GitHub's default markdown rendering, the tagline
sits in a blockquote under the H1.

### 4.3 Landing page

Single-column, generous spacing, type-driven. Sections separated by
`--space-20` or more. No images of dashboards in the hero (dashboards as
hero images are a worn fintech cliché and undercut the editorial posture).

Reference: anthropic.com homepage structure. Editorial, restrained, confident.

### 4.4 Dashboard

The Sentinel dashboard predates the brand guide and currently uses its own
color tokens in `frontend/src/styles.css`. A future refresh will migrate
those to the Stone scale and the typography defined here. Until that refresh,
the dashboard's existing visual language is acceptable as-is.

When the refresh happens, follow this guide.

---

## 5. Anti-patterns

Things that violate the brand and should be rejected in PR review:

- **Bright or saturated colors** on brand surfaces. The accent palette is
  reserved for charts inside the dashboard. A landing page button in
  saturated blue is a brand violation.
- **Decorative gradients.** No gradients on brand surfaces, ever. The Stone
  scale gives all the depth needed.
- **Shadows-as-decoration.** Shadows for elevation only, never for visual
  interest.
- **Marketing voice.** "Empower," "unlock," "delight," "transform" — all out.
- **Emoji headers.** Plain text headers throughout.
- **Stock photography.** No stock photos. If imagery is needed, commission
  original work or use editorial illustration consistent with the palette.
- **Rounded corners > 8px on rectangles.** Pill radius is reserved for actual
  pills.
- **Multiple icon sets mixed.** Lucide only.
- **All-caps body text.** Acceptable for `--text-body-xs` labels with
  +0.05em letter-spacing. Never for body sentences.

---

## 6. Open questions

The brand will evolve. Items deliberately deferred:

- **Dark mode.** The Stone scale inverts cleanly (cream surface → ink surface,
  ink text → cream text), but the inversion has not been validated against
  accessibility and against the dashboard. Defer to post-launch.
- **Optional logo mark.** A subtle glyph derived from the "ó" diacritic may be
  developed later. Until designed and approved, the wordmark is the entire
  logo system.
- **Illustration system.** If editorial illustrations become necessary for blog
  posts or documentation, define the style in a future revision.
- **Sound / motion.** Not currently in scope. Add when needed.

---

*Maintainers update this document via PR with explicit rationale. Voice and
visual identity changes affect every surface; treat them as architecture, not
preference.*