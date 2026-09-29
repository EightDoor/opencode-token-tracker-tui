# Contributing to opencode-token-tracker-tui

This project is owned and maintained by
[EightDoor](https://github.com/EightDoor). Contributions are welcome via
pull request.

## Branch Strategy

```
main     <- stable releases, published to npm by the owner
  |
dev      <- development branch, features merge here first
  |
feature/ <- feature branches (feature/xxx)
fix/     <- bug fix branches (fix/xxx)
```

### Workflow

1. **Feature Development**
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/my-feature
   # ... make changes ...
   git push origin feature/my-feature
   # Create PR to dev
   ```

2. **Bug Fixes**
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b fix/my-fix
   # ... make changes ...
   git push origin fix/my-fix
   # Create PR to dev
   ```

3. **Release to main**
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b release/vX.Y.Z
   # bump version in package.json, update CHANGELOG.md
   git commit -am "chore(release): bump version to X.Y.Z"
   # open PR: release/vX.Y.Z -> main
   ```

   After the release PR is merged and `main` is clean and synced:
   ```bash
   git checkout main
   git pull origin main
   npm ci
   npm run build
   npm test
   npm publish --access public
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   Publishing is done locally by the owner — there is no automated
   release workflow on GitHub Actions.

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix a bug
docs: update documentation
chore: maintenance tasks
refactor: code refactoring
test: add or update tests
```

## Development Setup

```bash
git clone https://github.com/EightDoor/opencode-token-tracker-tui.git
cd opencode-token-tracker-tui
npm install
```

## Testing Locally

1. Link the package:
   ```bash
   npm link
   ```

2. Add to your OpenCode config (`~/.config/opencode/config.json`):
   ```json
   {
     "plugins": ["opencode-token-tracker-tui"]
   }
   ```

3. Restart OpenCode.

## Code Style

- TypeScript with strict mode
- ES2022 target
- ESM modules (`"type": "module"`)
- No external runtime dependencies beyond `@opencode/plugin`

## Pull Request Guidelines

- Target the `dev` branch (not `main`)
- Include a clear description of changes
- Update `README.md` / `README.zh-CN.md` if adding or changing user-facing
  features
- Update `CHANGELOG.md` for any user-visible change
- Ensure build passes: `npm run build`
- Ensure tests pass: `npm test`