import * as fs from "node:fs/promises";
import * as path from "node:path";
import { modify, applyEdits } from 'jsonc-parser';
import { execSync } from 'node:child_process';
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
async function setDependencies(infos) {
    for (let key in infos) {
        await patchPackage(infos[key], infos);
    }
}
async function incrementVersion(mustIncr, incrAll, infos) {
    for (let key in infos) {
        let pkg = infos[key];
        if (!incrAll) {
            if (!mustIncr.includes(pkg.name)) {
                continue;
            }
        }
        let version = pkg.version;
        if (!version) {
            console.warn(pkg.name + " has no version number");
            return;
        }
        let tag = "";
        if (version.includes("-")) {
            let idx = version.indexOf("-");
            tag = version.substring(idx);
            version = version.substring(0, idx);
        }
        let versionParts = version.split(".");
        let sRev = versionParts.pop();
        let sMinor = versionParts.pop();
        let sMajor = versionParts.pop();
        let newVersion = sMajor + "." + sMinor + "." + (parseInt(sRev) + 1) + tag;
        pkg.version = newVersion;
        let jsonText = await fs.readFile(pkg.filePath, "utf-8");
        let updated = modify(jsonText, ["version"], newVersion, {});
        let output = applyEdits(jsonText, updated);
        await fs.writeFile(pkg.filePath, output);
    }
}
async function publishPackage(mustPublish, publishAll, infos) {
    for (let key in infos) {
        let pkg = infos[key];
        if (!publishAll) {
            if (!mustPublish.includes(pkg.name)) {
                continue;
            }
        }
        if (pkg.version) {
            try {
                const cwd = path.dirname(pkg.filePath);
                execSync(PUBLISH_COMMAND, { stdio: 'ignore', cwd });
                console.log(`✅  ${pkg.name} published with success. Version ${pkg.version}`);
            }
            catch (error) {
                const exitCode = error.status || error.code || 1;
                console.log(`❌  can't publish ${pkg.name}. Version ${pkg.version}`);
            }
        }
    }
}
async function exec() {
    async function doIncr() {
        let toProcess;
        let processAll = false;
        if (INCR) {
            if (INCR instanceof Array) {
                toProcess = INCR;
            }
            else if (INCR === "*") {
                processAll = true;
                toProcess = [];
            }
            else {
                toProcess = [INCR];
            }
        }
        else {
            toProcess = [];
        }
        await incrementVersion(toProcess, processAll, infos);
    }
    async function doPublish() {
        let toProcess;
        let processAll = false;
        if (PUBLISH) {
            if (PUBLISH instanceof Array) {
                toProcess = PUBLISH;
            }
            else if (PUBLISH === "*") {
                processAll = true;
                toProcess = [];
            }
            else {
                toProcess = [PUBLISH];
            }
        }
        else {
            toProcess = [];
        }
        await publishPackage(toProcess, processAll, infos);
    }
    let infos = await findPackageJsonFiles("/Users/johan/Projets/jopi-rewrite-workspace");
    await doIncr();
    await setDependencies(infos);
    await doPublish();
}
const INCR = "*";
const PUBLISH = "*";
const PUBLISH_COMMAND = "bun publish";
exec().then();
;
//# sourceMappingURL=index.js.map