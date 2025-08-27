# Jopi Mono

## What is it?

### First goal

Jopi Mono allows replacing a workspace version into a large monorepo tree.
If it's usefull, it's in order to avoid the hell of a version mismatch when publishing a package with Yarn or Bun.

Jopi Mono works by replacing all "workspace:" version numbers with the exact version number of the package found
in the monorepo. Doing this forces the package manager to export the correct dependency and avoid strange and
unpredictable behaviors.

### The second goal

The second is to make publishing packages easier, allowing to automatically increase version number before publishing 
and automatically re-build the package.

## How to use?

TODO - The tool in actually a hack and run tool, and will become a real tool with command line parameters.

```
jopi-mono update-versions jopi-rewrite jopi-rewrite-ui jopi-loader
jopi-mono publish jopi-rewrite jopi-rewrite-ui jopi-loader --incr-revision
```