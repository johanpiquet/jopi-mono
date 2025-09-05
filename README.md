# Jopi-Mono

A powerful monorepo version management tool designed to streamline package versioning across multiple projects in a single repository.

## 🎯 Project Goal

Jopi-Mono aims to simplify version management in monorepo environments by providing:
- Centralized version control across all packages
- Automated dependency synchronization
- Consistent release workflows
- Cross-package dependency tracking

## 🚀 What You Can Do

### Version Management
- **Unified Versioning**: Manage versions across all packages from a single point
- **Dependency Tracking**: Automatically track and update inter-package dependencies
- **Release Coordination**: Coordinate releases across multiple packages simultaneously

### Workspace Operations
- **Package Discovery**: Automatically detect and manage packages in your monorepo
- **Dependency Resolution**: Resolve complex dependency graphs between packages
- **Build Orchestration**: Coordinate builds across dependent packages

## 📖 How to Use

### Installation

Requirements
- Bun 1.2+ (recommended) or Node.js 18+
- Git 2.30+
- A monorepo using workspaces (npm, pnpm, Yarn, or Bun)

Install with Bun (recommended):
````sh
bun install jopi-mono --global
````
Or run directly with Bunx (no install needed):
```sh
bunx jopi-mono --help
```

## 📝 Command Line Usage

See all available commands:
```sh
bunx jopi-mono --help
```

Get help for a specific command:
```sh
bunx jopi-mono <command> --help
```

Typical commands include:
- `check` – List packages which have changes since last publication.
- `publish` – Publish all the packages with have changes since last publication.
- `revert` – Revert package version number to the public version.
- `versions` – Print info about package versions.
- `install` – Install dependencies using bun install.
- `update` – Update dependencies using bun update.
- `ws-add <url>` – Clone a git repository into the workspace.
- `ws-detach <url>` – Detach a project, removing dependencies of type workspace.

## 📝 Example Usage

Publish all updated repo:
```sh
bunx jopi-mono publish
```

Publish only selected packages:
```sh
bunx jopi-mono publish jopi-mono my-second-package
```

Fake it, for test:
```sh
bunx jopi-mono publish --fake
```

List the versions of all your packages (show the public and the local version number):
```sh
bunx jopi-mono version
```

## 📚 License

This project is licensed under the MIT License.