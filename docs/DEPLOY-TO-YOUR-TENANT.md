# Deploy Cowork Companion to your tenant

This path creates a new managed app and platform-managed repository in a specific Power Platform environment. It does not reuse the original app ID, environment ID, repository ID, or OneDrive connection.

## Prerequisites

You need:

- Windows, macOS, or Linux with Git
- Node.js 22 or later and npm
- Microsoft Managed Apps CLI
- A Microsoft 365 account in the target tenant
- Maker access to the target Power Platform environment
- OneDrive for Business enabled for that account
- Cowork content under `/Documents/Cowork`

Install the command-line tools on Windows:

```powershell
winget install --id Git.Git --exact
winget install --id OpenJS.NodeJS.LTS --exact
npm install --global @microsoft/managed-apps-cli@latest
```

Authenticate:

```powershell
ms auth login
ms auth status
```

If more than one account is cached, select the target-tenant account:

```powershell
ms auth switch --account "<USER_PRINCIPAL_NAME>"
```

Find the target environment ID in the Power Platform admin center or environment URL. Use the environment GUID, not a Cowork task/session GUID.

## Deploy

```powershell
$EnvironmentId = "<TARGET_ENVIRONMENT_ID>"

git clone https://github.com/scottdurow/cowork-companion.git
Set-Location cowork-companion
npm ci

ms app init `
  --display-name "Cowork Companion" `
  --description "A OneDrive-powered companion and navigator for Microsoft Copilot Cowork" `
  --environment-id $EnvironmentId `
  --repo native `
  --non-interactive

ms app add data-source `
  --connector shared_onedriveforbusiness `
  --as action `
  --use-sso `
  --skip-codegen `
  --non-interactive

npm run typecheck
npm run build
npm run lint

# Keep a convenient read-only link back to the public source.
git remote add public https://github.com/scottdurow/cowork-companion.git

# ms.config.json is intentionally ignored in the public source but is required
# in this target-specific platform repository.
git add -f ms.config.json
git commit -m "chore: configure target deployment"

# A new platform repository contains a server-created initial commit.
git fetch origin
git merge origin/main `
  --allow-unrelated-histories `
  --strategy=ours `
  -m "chore: integrate platform repository"
git push -u origin HEAD

$DeployCommit = git rev-parse HEAD
ms app deploy --commit $DeployCommit
ms app play
```

`--repo native` creates a platform-managed repository in the target environment. This path works even when the environment disables external-artifact deployment and does not require installing the Microsoft Managed Apps GitHub App. `ms app init` changes `origin` to the new platform repository; the added `public` remote retains an easy route back to this repository. `--skip-codegen` preserves the reviewed typed OneDrive client while creating a new target-specific connection binding.

## First run

1. Open the URL returned by `ms app play`.
2. Authorize the OneDrive connection if prompted.
3. Leave Demo mode on to inspect the interface, or go to **Settings** and turn Demo mode off.
4. Refresh the app.
5. Confirm tasks under `/Documents/Cowork/Tasks` appear.
6. Open **Skills** and **Memory** to confirm visible Cowork content is discovered.

The app creates `/Documents/cowork-companion.json` only when it first needs to persist companion-owned metadata.

## Environment-specific notes

- Each deployment has its own app ID and OneDrive connection.
- The signed-in user's OneDrive is read; app data is not copied from the source tenant.
- Projects, pins, archives, Cowork URLs, preferences, and seen state are stored in that user's companion metadata file.
- Deleting a project or archiving a task does not delete Cowork task files.

## Validate or reopen an existing deployment

```powershell
npm run typecheck
npm run build
npm run lint
ms app play --mode live
```

To deploy a later source revision:

```powershell
git fetch public
git merge public/main
npm ci
npm run typecheck
npm run build
npm run lint
git add --all
git commit -m "chore: update Cowork Companion"
git push origin HEAD
ms app deploy --commit (git rev-parse HEAD)
```

## Troubleshooting

### Wrong tenant account

```powershell
ms auth status
ms auth switch --account "<USER_PRINCIPAL_NAME>"
```

### Target environment rejected

Confirm the environment GUID and that the active account has Maker access. The environment must belong to the active account's tenant.

### External artifact deployment is not enabled

Use the documented `--repo native` path. `--repo none` requires the target environment's `AllowExternalArtifactDeployment` setting, which many environments disable.

### OneDrive connection is ambiguous

Run the data-source command interactively and choose the intended connection:

```powershell
ms app add data-source --connector shared_onedriveforbusiness --as action
```

Or pass a known connection:

```powershell
ms app add data-source `
  --connector shared_onedriveforbusiness `
  --as action `
  --connection-id "<CONNECTION_ID>" `
  --non-interactive
```

### No Cowork tasks appear

Verify the signed-in user's OneDrive contains `/Documents/Cowork`. Cowork Companion discovers observable folders and files; it does not copy sample data into live mode.

### Build fails after cloning

Use Node.js 22 or later, remove no generated connector files, and restore exactly from the lock file:

```powershell
node --version
npm ci
npm run typecheck
npm run build
```
