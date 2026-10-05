# Move a Cowork-developed managed app to public GitHub

This runbook records the shortest repeatable process used for Cowork Companion. It exports the platform-managed repository, removes tenant-specific registration, squashes the generated history into one public commit, and pushes a new public GitHub repository.

## Prerequisites

Install Git, Node.js 22 or later, GitHub CLI, and the Microsoft Managed Apps CLI.

```powershell
winget install --id Git.Git --exact
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id GitHub.cli --exact
npm install --global @microsoft/managed-apps-cli@latest
```

Verify the tools:

```powershell
git --version
node --version
npm --version
gh --version
ms --version
```

Authenticate both services:

```powershell
gh auth login
ms auth login
gh auth status
ms auth status
```

Use the same Microsoft account that owns or can edit the Cowork-created app. Complete browser authentication yourself; never paste credentials into a script.

## 1. Publish in Cowork

In the Cowork app preview:

1. Run the app's checks and test the unpublished preview.
2. Select **Publish**.
3. Wait for publication to finish.
4. Confirm the app appears in the CLI:

```powershell
ms app list --json
```

Record the app ID and environment ID for the Cowork-created app.

## 2. Clone the platform-managed repository

```powershell
$AppId = "<COWORK_APP_ID>"
$SourceEnvironmentId = "<SOURCE_ENVIRONMENT_ID>"
$TargetDirectory = "C:\src\cowork-companion"

ms app clone $TargetDirectory `
  --app $AppId `
  --environment-id $SourceEnvironmentId `
  --non-interactive `
  --json

Set-Location $TargetDirectory
```

For this app, the command used was:

```powershell
ms app clone C:\repos\cowork-companion `
  --app af7686b5-80fe-42ed-a4fa-7e305cc48b54 `
  --environment-id a9723780-d201-e296-83e1-738d5baa68f2 `
  --non-interactive `
  --json
```

## 3. Make the source portable

The cloned `ms.config.json` identifies the original app, environment, platform repository, and connector binding. Do not publish it as a reusable deployment configuration.

```powershell
Remove-Item .\ms.config.json
Add-Content .\.gitignore "`n# Created per target tenant/environment`nms.config.json"
```

Keep the generated connector client in `generated/`; target installers recreate the OneDrive connection with the CLI.

Review the repository for secrets before making it public:

```powershell
git grep -n -I -E "(password|client_secret|access_token|refresh_token|api[_-]?key)"
git status --short
```

Manually inspect every reported match. Do not publish credentials, tokens, tenant secrets, `.env*.local`, or private test data.

## 4. Validate the exported source

```powershell
npm ci
npm run typecheck
npm run build
npm run lint
```

## 5. Squash the Cowork history into one public commit

The Cowork-managed repository contains generated sync commits. Create one root commit from the validated tree, then point the local `main` branch at it. This leaves the files untouched and does not rewrite the Cowork platform repository.

```powershell
git add --all
git commit -m "feat: prepare public release"
git remote rename origin cowork-source

$Tree = git rev-parse "HEAD^{tree}"
$RootCommit = git commit-tree $Tree `
  -m "feat: publish Cowork Companion"

git branch public-main $RootCommit
git switch public-main
git branch --force main $RootCommit
git switch main
git branch --delete public-main
```

Verify that the public history has one commit:

```powershell
git rev-list --count HEAD
git log --oneline --decorate
```

## 6. Create and push the public repository

The GitHub repository must not already exist:

```powershell
gh repo create scottdurow/cowork-companion `
  --public `
  --description "A OneDrive-powered companion and navigator for Microsoft Copilot Cowork" `
  --source . `
  --remote origin `
  --push
```

Verify:

```powershell
gh repo view scottdurow/cowork-companion --json nameWithOwner,visibility,url,defaultBranchRef
git remote -v
git status --short --branch
```

The local `cowork-source` remote remains useful for comparing future Cowork changes. It is local Git configuration and is not published to GitHub.

## Updating the public repository later

Pull or clone the latest Cowork-managed revision into a separate working directory, copy the reviewed source changes into the public checkout, validate, and commit normally. Do not merge the generated Cowork sync history into the public repository.
