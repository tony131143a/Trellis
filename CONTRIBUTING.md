# Contributing to Arbor

Arbor is a personal fork. Contributions are welcome through issues and pull requests on this repository.

## Issues

Check existing issues first. For a bug include:

- `arbor --version`, `node --version`, operating system
- Steps to reproduce, expected and actual behavior
- Relevant logs

For a feature, describe the use case and discuss it in an issue before sending code.

## Development setup

Requires Node.js >= 18, pnpm, Python >= 3.9.

```bash
pnpm install
pnpm build
```

## Test gates

Run before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @tony131143a/arbor lint:py   # basedpyright, when Python changed
python3 ./.arbor/scripts/spec.py lint      # when spec docs changed
```

Pre-commit hooks run `eslint --fix` and `prettier --write` on staged `.ts` files.

## Dogfood byte-identity rule

`.arbor/scripts/` is this repo's own copy of the scripts that ship from `packages/cli/src/templates/arbor/scripts/`. Every `.py` file must be byte-identical in both trees, and the two trees must hold the same set of files. Change both in the same commit. A regression test fails on drift.

More generally, when you change `.claude/` or `.arbor/`, check whether the matching file under `packages/cli/src/templates/` needs the same change, because the templates are what `arbor init` installs.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, with an optional scope such as `fix(hooks): ...`.

Branch from `main`, keep the gates above green, and describe the change and any related issue in the pull request.

## License

Arbor is distributed under AGPL-3.0-or-later (see `LICENSE`, `NOTICE`, `COPYRIGHT`). By contributing you agree your contribution is licensed under the same terms.
