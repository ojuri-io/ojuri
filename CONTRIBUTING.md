# Contributing to Ojuri

Thanks for your interest in improving Ojuri.

## Project shape

Ojuri is a polyglot monorepo. There are four backend services and one frontend, each with its own dependencies and build:

- **RDA** — Real-Time Detection Agent. TypeScript + Fastify HTTP API. Lives at the repo root (`src/`); owns the root `package.json` and the Knex migrations under `src/database/migrations/`.
- **PAA** — Pattern Analysis Agent. TypeScript + KafkaJS worker. Lives under [`paa-service/`](paa-service/).
- **MLA** — Model Learning Agent. Python 3.11. Lives under [`mla-service/`](mla-service/). Trains XGBoost models and converts them to ONNX for RDA.
- **FIA** — Fraud Investigation Agent. Python 3.11. Lives under [`fia-service/`](fia-service/). Consumes blocked transactions and produces LLM-written investigation reports.
- **Sentinel** — Operator dashboard. React 18 + Vite. Lives under [`frontend/`](frontend/).

Database migrations are owned by RDA at `src/database/migrations/`. PAA, MLA, and FIA all read and write the same `fraud_db` but do not own schema — schema changes go through the root.

## Before you start

Read the [README](README.md) for setup and the [architecture overview](docs/ARCHITECTURE.md) for service boundaries. The full per-feature reference lives in [`docs/`](docs/).

For anything beyond a one-line fix, open an issue first so we can confirm direction before you spend time on it. The project is maintained by one person right now, so review SLAs are best-effort — expect a first response within a few days, not a few hours.

## Development workflow

1. Fork the repo and create a branch off `main`. Branch prefixes we use:
   - `feat/` — new features
   - `fix/` — bug fixes
   - `docs/` — documentation only
   - `refactor/` — internal change with no behaviour delta
   - `test/` — adding or fixing tests
2. Make small, focused changes. One PR per concern. A PR that touches the rules engine, the dashboard, and adds a new migration is three PRs.
3. Rebase onto `main` before opening the PR.
4. Open the PR with a clear description of what changed and why.

## Per-service quick reference

Each service has its own `node_modules` / `venv` / dependencies. Installing the root does not install the others.

### RDA (root)

```bash
npm install
npm run start:dev          # nodemon hot-reload on :3000
npm run build              # tsc; postbuild copies *.yaml into dist/
npm run lint
npm test                   # jest --runInBand --passWithNoTests
npm run db:migrate         # apply migrations
npm run db:migrate:make -- name_of_migration
```

### PAA — `paa-service/`

```bash
cd paa-service
npm install
npm run start:dev
npm run build
npm run lint
npm test
```

### MLA — `mla-service/`

```bash
cd mla-service
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m src.main                          # start drift-monitoring loop
python scripts/train_initial_model.py       # cold-start training
pytest
```

ONNX library versions are deliberately pinned in `requirements.txt` for XGBoost compatibility — do not bump `onnx`, `onnxmltools`, or `onnxconverter-common` without end-to-end testing the training → ONNX → RDA inference path. See [`mla-service/README.md`](mla-service/README.md#onnx-compatibility).

### FIA — `fia-service/`

```bash
cd fia-service
python3.11 -m venv .venv                    # .venv (FIA), not venv (MLA)
source .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=. python -m src.main
```

The full stack pulls down ~7.6 GB of Phi-3-mini-4k-instruct weights on first run. For wiring work, CI, or laptops without spare disk you can run with `FIA_FALLBACK_ON_LLM_FAILURE=true` (the default), which degrades to a deterministic rule-based report when the LLM cannot load. The pipeline still produces parseable rows, so most integration changes can be tested without the heavy stack.

### Frontend — `frontend/`

```bash
cd frontend
npm install
npm run dev          # vite dev server on :5173
npm run build
npm test             # vitest run (jsdom + Testing Library)
npm test -- tests/sidebar.test.jsx
```

The dev server proxies `/v1/*` → RDA and `/fia/*` → FIA. See [`docs/FRONTEND.md`](docs/FRONTEND.md).

## Code style

The TypeScript services (RDA, PAA) use [ESLint][eslint] and [Prettier][prettier] via lint-staged on commit. Run `npm run lint` (or `npm run lint:fix`) before opening a PR. The repo does not currently ship dedicated `.eslintrc` / `.prettierrc` files at the root — ESLint resolves the standard preset listed in `package.json` devDependencies (`eslint-config-standard` + `eslint-config-prettier`). If you find yourself fighting the linter on style trivia, match the surrounding code.

The frontend uses ESLint via `npm run lint` in `frontend/`.

The Python services (MLA, FIA) do not currently configure a formatter or linter in the repo — match the surrounding style. MLA's `requirements.txt` lists `black` and `flake8` as dev dependencies; if you run them locally that's fine, but there's no enforced configuration yet.

When in doubt: read the file you are editing and follow its conventions.

## Testing

Each service has its own test framework:

- RDA — Jest (`npm test` at the root)
- PAA — Jest (`npm test` in `paa-service/`)
- MLA — pytest (`pytest` in `mla-service/` with venv active)
- FIA — pytest (`pytest` in `fia-service/` with venv active)
- Frontend — Vitest (`npm test` in `frontend/`)

We do not enforce a coverage threshold. The expectation is that new code comes with tests for the behaviour you added or changed, that bug fixes come with a regression test, and that you do not delete or skip existing tests without justification in the PR description.

Run the test suite for every service your PR touches before requesting review. GitHub Actions also runs every check the workshop publishes — see [`docs/CI.md`](docs/CI.md) for the full job list and how to reproduce the Docker smoke step locally.

## Commit messages

Recent history uses [Conventional Commits][conventional]: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, optionally with a scope (`fix(frontend): …`, `feat(fia): …`). This is recommended, not enforced — there is no commit-msg hook today. Keep the subject under ~72 characters and write in the imperative mood ("add", not "added").

Do **not** include `Co-Authored-By: Claude …` trailers. We do not use them.

## Pull request expectations

Reviewers look for:

- **Correctness** — the change does what the description says and nothing else.
- **Tests** — new behaviour is exercised; bug fixes include a regression test.
- **Docs updated** — if you changed an API, an env var, a config knob, a schema, or a workflow, the relevant doc in [`docs/`](docs/) or the service README is updated in the same PR.
- **No scope creep** — unrelated refactors belong in a separate PR.
- **No new flakiness** — tests should be deterministic. If you introduce timing, mock the clock.
- **Migrations are reversible** — every new Knex migration ships with a working `down`.
- **No secrets** — never commit `.env`, credentials, or real keys. The repo has `.env.example` files for every service; update those instead.

## Where to discuss

- **Bugs and concrete proposals** — [GitHub Issues][issues].
- **Open-ended ideas, questions, "should this work this way?"** — [GitHub Discussions][discussions] (if enabled; otherwise open an issue tagged `discussion`).
- **Security vulnerabilities** — see [SECURITY.md](SECURITY.md). Do not report security issues in public issues, discussions, or PRs.

## Recognition

There is no `CONTRIBUTORS.md` today — credits go in release notes. If you would prefer not to be named, say so in the PR.

## License

By submitting a pull request, you agree that your contributions are licensed under the [MIT License](LICENSE).

[eslint]: https://eslint.org/
[prettier]: https://prettier.io/
[conventional]: https://www.conventionalcommits.org/
[issues]: https://github.com/ojuri-io/ojuri/issues
[discussions]: https://github.com/ojuri-io/ojuri/discussions
