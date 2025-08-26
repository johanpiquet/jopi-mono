import * as fs from "node:fs/promises";
import * as path from "node:path";
import { modify, applyEdits } from 'jsonc-parser';
/**
 * Find all package.json from here.
 */
async function findPackageJsonFiles(dir = process.cwd(), result = {}) {
    async function extractPackageInfos(filePath) {
        let fileContent = await fs.readFile(filePath, "utf8");
        let json = JSON.parse(fileContent);
        return {
            filePath,
            name: json.name,
            version: json.version
        };
    }
    const files = await fs.readdir(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
            if (file !== 'node_modules') {
                await findPackageJsonFiles(fullPath, result);
            }
        }
        else if (file === 'package.json') {
            let infos = await extractPackageInfos(path.relative(process.cwd(), fullPath));
            result[infos.name] = infos;
        }
    }
    return result;
}
async function patchPackage(pkg, infos) {
    function patch(key, dependencies) {
        if (!dependencies)
            return;
        for (let pkgName in dependencies) {
            let pkgInfos = infos[pkgName];
            if (pkgInfos) {
                dependencies[pkgName] = "workspace:=" + pkgInfos.version;
                changes.push(() => {
                    let newModif = modify(jsonText, [key, pkgName], "workspace:^" + pkgInfos.version, {});
                    updated = updated ? updated.concat(newModif) : newModif;
                });
            }
        }
    }
    const changes = [];
    let jsonText = await fs.readFile(pkg.filePath, "utf-8");
    let json = JSON.parse(jsonText);
    patch("dependencies", json.dependencies);
    patch("devDependencies", json.devDependencies);
    let updated;
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
//# sourceMappingURL=index.js.map