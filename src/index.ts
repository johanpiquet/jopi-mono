import * as fs from "node:fs/promises";
import * as path from "node:path";
import {modify, applyEdits, type EditResult} from 'jsonc-parser';

/**
 * Find all package.json from here.
 */
async function findPackageJsonFiles(dir: string = process.cwd(), result: Record<string, PackageInfos> = {}): Promise<Record<string, PackageInfos>> {
    async function extractPackageInfos(filePath: string): Promise<PackageInfos> {
        let fileContent = await fs.readFile(filePath, "utf8");
        let json = JSON.parse(fileContent);

        return {
            filePath,
            name: json.name,
            version: json.version
        }
    }

    const files = await fs.readdir(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            if (file !== 'node_modules') {
                await findPackageJsonFiles(fullPath, result);
            }
        } else if (file === 'package.json') {
            let infos = await extractPackageInfos(path.relative(process.cwd(), fullPath));
            result[infos.name] = infos;
        }
    }

    return result;
}

interface PackageInfos {
    name: string;
    version: string;
    filePath: string;
}

async function patchPackage(pkg: PackageInfos, infos: Record<string, PackageInfos>) {
    function patch(key: string, dependencies: Record<string, string>) {
        if (!dependencies) return;

        for (let pkgName in dependencies) {
            let pkgInfos = infos[pkgName];

            if (pkgInfos) {
                dependencies[pkgName] = "workspace:=" + pkgInfos.version;

                changes.push(() => {
                    let newModif = modify(jsonText, [key, pkgName], "workspace:^" + pkgInfos.version, {})
                    updated = updated ? updated.concat(newModif) : newModif;
                });
            }
        }
    }

    const changes: (()=>void)[] = [];

    let jsonText = await fs.readFile(pkg.filePath, "utf-8");
    let json = JSON.parse(jsonText);

    patch("dependencies", json.dependencies);
    patch("devDependencies", json.devDependencies);

    let updated: EditResult|undefined;
    changes.forEach(c => c());

    if (updated) {
        let output = applyEdits(jsonText, updated);
        await fs.writeFile(pkg.filePath, output);
    }
}

async function test() {
    let infos = await findPackageJsonFiles("/Users/johan/Projets/jopi-rewrite-workspace");

    for (let key in infos) {
        await patchPackage(infos[key], infos);
    }
}

test().then();