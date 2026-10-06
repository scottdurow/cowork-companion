# Cowork Companion

Cowork Companion is a lightweight navigator for Microsoft Copilot Cowork content stored in OneDrive. It discovers observable task, skill, memory, input, and output files under `/Documents/Cowork` and adds app-owned organization without changing Cowork's folders.

The current managed-app release is **v1.0.0**. The product release is defined once in `src/lib/app-version.ts`; the protected scaffold version in `package.json` is tooling metadata and is not the deployed product version.

## Features

- Task dashboard with recent-change indicators, pinning, archiving, and virtual projects
- Full-page task workspaces optimized for output files
- Direct browser links for OneDrive files
- Cowork session URL assignment
- Skills and memory browsing
- Hash-based navigation with browser Back/Forward support
- System, Light, and Dark appearance modes
- Live OneDrive mode plus an optional local demo mode

## Deploy to your tenant

The shortest supported path is:

```powershell
git clone https://github.com/scottdurow/cowork-companion.git
Set-Location cowork-companion
npm ci
ms auth login
ms app init --display-name "Cowork Companion" --environment-id "<ENVIRONMENT_ID>" --repo native --non-interactive
ms app add data-source --connector shared_onedriveforbusiness --as action --use-sso --skip-codegen --non-interactive
npm run build
git add -f ms.config.json
git commit -m "chore: configure target deployment"
git fetch origin
git merge origin/main --allow-unrelated-histories --strategy=ours -m "chore: integrate platform repository"
git push -u origin HEAD
ms app deploy --commit (git rev-parse HEAD)
ms app play
```

See [Deploy to your tenant](docs/DEPLOY-TO-YOUR-TENANT.md) for prerequisites, environment selection, connector details, validation, and troubleshooting.

## Develop locally

```powershell
npm ci
npm run typecheck
npm run build
npm run lint
ms app dev
```

The live connector requires a target-specific `ms.config.json`, created by `ms app init` and `ms app add data-source`. That file is intentionally excluded from this public repository because it contains tenant-specific app, environment, repository, and connection identifiers.

## Publish a Cowork-developed app to GitHub

See [Cowork to public GitHub](docs/COWORK-TO-PUBLIC-GITHUB.md) for the complete command sequence used to export this app, squash the Cowork-managed history into one public commit, and publish the repository.

## Data and privacy

- OneDrive is the source of observable Cowork information.
- Companion-owned state is stored in `/Documents/cowork-companion.json`.
- Projects, assignments, pins, archives, Cowork URLs, preferences, and seen state are companion metadata only.
- The app does not claim Cowork runtime state that cannot be observed in OneDrive.

## License

[MIT](LICENSE)
