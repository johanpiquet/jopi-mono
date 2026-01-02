import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { applyEdits, type EditResult, modify } from 'jsonc-parser';
import { execFileSync, execSync } from 'node:child_process';
import * as jk_fs from "jopi-toolkit/jk_fs";
import * as jk_timer from "jopi-toolkit/jk_timer";
import * as jk_term from "jopi-toolkit/jk_term";
import * as jk_app from "jopi-toolkit/jk_app";

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as process from "node:process";

const VERSION = "2.2";

interface PackageInfos {
    name: string;

    version: string;
    version_beforeIncr?: string;

    packageJsonFilePath: string;
    publicVersion?: string;
    packageHash?: string;
    isPrivate: boolean;
    isValidForPublish: boolean;
}

interface IsPackageJson {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

//region Cache

let gCacheDir: string | undefined;

function getCacheDir(): string {
    if (!gCacheDir) {
        gCacheDir = path.join(gCwd, ".jopi-mono");
    }

    return gCacheDir;
}

interface CacheFileOptions {
    subDir: string[];
}

function getCacheFilePath(fileName: string, options?: CacheFileOptions): string {
    let subDirs = options?.subDir || [];
    return path.join(getCacheDir(), ...subDirs, fileName);
}

async function getCacheFile_json<T>(fileName: string, options?: CacheFileOptions): Promise<T | undefined> {
    let text = await getCacheFile(fileName, options);
    if (!text) return undefined;

    try {
        return JSON.parse(text);
    }
    catch {
        console.error("Can't parse json for file", getCacheFilePath(fileName, options));
        return undefined;
    }
}

async function deleteCacheFile(fileName: string): Promise<void> {
    let filePath = getCacheFilePath(fileName);
    await jk_fs.unlink(filePath);
}

function saveCacheFile_json(fileName: string, content: any, options?: CacheFileOptions): Promise<void> {
    return saveCacheFile(fileName, JSON.stringify(content, null, 2), options);
}

async function getCacheFile(fileName: string, options?: CacheFileOptions): Promise<string | undefined> {
    let filePath = getCacheFilePath(fileName, options);
    return await jk_fs.readTextFromFile(filePath);
}

async function saveCacheFile(fileName: string, content: string, options?: CacheFileOptions): Promise<void> {
    let filePath = getCacheFilePath(fileName, options);
    await jk_fs.writeTextToFile(filePath, content);
}

//endregion

//region Backup

async function backupAllPackageJson(pkgInfos: Record<string, PackageInfos>) {
    async function backup(pkg: PackageInfos) {
        let targetFile = getCacheFilePath(pkg.name + ".json", { subDir: ["backup"] });
        let content = await jk_fs.readTextFromFile(pkg.packageJsonFilePath);
        await jk_fs.writeTextToFile(targetFile, content, true);
    }

    await Promise.all(Object.values(pkgInfos).map(async pkg => {
        await backup(pkg);
    }));
}

async function restoreThisPackage(pkg: PackageInfos) {
    let targetFile = getCacheFilePath(pkg.name + ".json", { subDir: ["backup"] });

    if (await jk_fs.isFile(targetFile)) {
        let content = await jk_fs.readTextFromFile(targetFile);
        await jk_fs.writeTextToFile(pkg.packageJsonFilePath, content, true);
        console.log("✅  Restored", pkg.name);
    }
}

async function restoreAllPackageJson(pkgInfos: Record<string, PackageInfos>) {
    await Promise.all(Object.values(pkgInfos).map(async pkg => {
        await restoreThisPackage(pkg);
    }));
}

//endregion

//region Helpers

interface CheckPackageHashOptions {
    onPackageChecked?: (hasChangeDetect: boolean, pkg: PackageInfos) => void;
}

async function searchWorkspaceDir(): Promise<string> {
    let currentDir = process.cwd();

    while (currentDir !== path.parse(currentDir).root) {
        const packageJsonPath = path.join(currentDir, 'package.json');

        try {
            const content = await fs.readFile(packageJsonPath, 'utf8');
            const packageJson = JSON.parse(content);

            if (packageJson.workspaces) {
                return currentDir;
            }
        } catch {
            // Continue if the file doesn't exist or can't be parsed
        }

        currentDir = path.dirname(currentDir);
    }

    return process.cwd();
}

async function searchPackageJsonFile(): Promise<string | undefined> {
    let currentDir = process.cwd();

    while (currentDir !== path.parse(currentDir).root) {
        const packageJsonPath = path.join(currentDir, 'package.json');
        if (await jk_fs.isFile(packageJsonPath)) return packageJsonPath;
        currentDir = path.dirname(currentDir);
    }

    return undefined;
}

/**
 * Return a list of packages which content is updated.
 * Which means that if doing a dry-run, then
 */
async function detectUpdatedPackages(pkgInfos: Record<string, PackageInfos>, options: CheckPackageHashOptions): Promise<string[]> {
    const updatedPackages: string[] = [];

    for (const key in pkgInfos) {
        const pkg = pkgInfos[key];
        if (!pkg.isValidForPublish) continue;

        let newHash = await getPackage_latestModificationDate(pkg);

        let hasChanges = !!(newHash && (pkg.packageHash !== newHash));
        if (hasChanges) updatedPackages.push(pkg.name);

        if (options?.onPackageChecked) {
            options.onPackageChecked(hasChanges, pkg);
        }
    }

    return updatedPackages;
}

async function loadPublicVersionInfos(pkgInfos: Record<string, PackageInfos>): Promise<void> {
    const cacheFileName = "public-versions.json";
    let fromCache = await getCacheFile_json<any>(cacheFileName);

    if (fromCache) {
        for (let pkgName of Object.keys(pkgInfos)) {
            let pkg = pkgInfos[pkgName];
            if (!pkg) continue;
            if (!pkg.isValidForPublish) continue;
            pkg.publicVersion = fromCache[pkgName] as string;
        }

        return;
    }

    fromCache = {};

    console.log("Fetching public version info...");

    for (let pkgName of Object.keys(pkgInfos)) {
        let pkg = pkgInfos[pkgName];
        if (!pkg) continue;
        if (!pkg.isValidForPublish) continue;

        try {
            console.log("... fetching", pkgName);
            const response = await fetch(`https://registry.npmjs.org/${pkgName}`);

            if (response.ok) {
                const packageData = await response.json();
                const versions = Object.keys(packageData.versions || {});
                fromCache[pkgName] = versions.length > 0 ? versions[versions.length - 1] : undefined;
            }
        } catch {
        }
    }

    await saveCacheFile_json(cacheFileName, fromCache)
    return loadPublicVersionInfos(pkgInfos);
}

/**
 * Find all package.json from here.
 */
async function findPackageJsonFiles(): Promise<Record<string, PackageInfos>> {
    async function extractPackageInfos(filePath: string): Promise<PackageInfos> {
        let fileContent = await fs.readFile(filePath, "utf8");
        let pkgJson = JSON.parse(fileContent);

        let isValidForPublish = true;
        if (pkgJson.isPrivate) isValidForPublish = false;
        else if (!pkgJson.name) isValidForPublish = false;
        else if (!pkgJson.version) isValidForPublish = false;

        return {
            packageJsonFilePath: filePath,
            isValidForPublish,
            name: pkgJson.name,
            version: pkgJson.version,
            isPrivate: pkgJson.private === true,
        }
    }

    async function searchInDirectories(dir: string, result: Record<string, PackageInfos>) {
        const files = await fs.readdir(dir);

        if (files.includes(".jopiMonoIgnore")) {
            return result;
        }

        for (const file of files) {
            const fullPath = path.join(dir, file);

            const stat = await jk_fs.getFileStat(fullPath);
            if (!stat) continue;

            if (stat.isDirectory()) {
                if (file !== 'node_modules') {
                    await searchInDirectories(fullPath, result);
                }
            } else if (stat.isFile()) {
                if (file === 'package.json') {
                    let infos = await extractPackageInfos(fullPath);
                    if (infos.name) result[infos.name] = infos;
                }
            }
        }

        return result;
    }

    return await searchInDirectories(gCwd, {});
}

async function getPackage_latestModificationDate(pkg: PackageInfos): Promise<string | undefined> {
    async function scanDirectories(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name[0] === '.') continue;

                if (!excludeDirs.includes(entry.name)) {
                    dirCount++
                    await scanDirectories(fullPath);
                }
            } else {
                fileCount++;

                const stats = await fs.stat(fullPath);
                const mtimeMs = stats.mtimeMs;
                if (maxTime < mtimeMs) maxTime = mtimeMs;
            }
        }
    }

    let maxTime = 0;
    let fileCount = 0;
    let dirCount = 0;

    let dirPath = path.dirname(pkg.packageJsonFilePath);
    let excludeDirs = ["dist", "build", "temp", "temps", "out"];

    await scanDirectories(dirPath);
    return maxTime.toString() + '-' + fileCount.toString() + '-' + dirCount.toString();
}

async function deletePackageHashInfos() {
    await deleteCacheFile(cacheFileName);
}

async function loadPackageHashInfos(pkgInfos: Record<string, PackageInfos>) {
    let cache = await getCacheFile_json<any>(cacheFileName);

    if (cache) {
        for (let pkgName of Object.keys(cache)) {
            let pkg = pkgInfos[pkgName];
            if (!pkg) continue;
            if (!pkg.isValidForPublish) continue;

            pkg.packageHash = cache[pkgName];
        }
    } else {
        cache = {};

        for (let pkg of Object.values(pkgInfos)) {
            if (!pkg.isValidForPublish) continue;

            jk_term.consoleLogTemp(true, `Calculating hash for ${pkg.name}`);
            pkg.packageHash = await getPackage_latestModificationDate(pkg);
            cache[pkg.name] = pkg.packageHash;
        }

        await saveCacheFile_json("packages-hash.json", cache);
    }
}

async function findPackageManager(): Promise<{ name: string; version: string; versionMajor: number; }> {
    let wpDir = await searchWorkspaceDir();
    //
    if (!wpDir) {
        console.error("Can't find workspace dir");
        process.exit(1);
    }

    let packageManager: string;

    try {
        let packageJson = await jk_fs.readTextFromFile(jk_fs.join(wpDir, "package.json"));
        let asJson = JSON.parse(packageJson);
        packageManager = asJson.jopiUsePackageManager;
        if (!packageManager) packageManager = asJson.packageManager;
    }
    catch {
        console.error("Can't read package.json");
        process.exit(1);
    }

    if (!packageManager) packageManager = "bun@1.3.0";

    let idx = packageManager.indexOf("@");
    let name = packageManager.substring(0, idx);
    let version = packageManager.substring(idx + 1);
    let versionMajor = parseInt(version.split(".")[0]);

    return {
        name,
        version,
        versionMajor
    };
}

const cacheFileName = "packages-hash.json";

//endregion

//region Actions

async function setDependenciesFor(pkg: PackageInfos, infos: Record<string, PackageInfos>, mode?: undefined | "reverting" | "detach") {
    function patch(key: string, dependencies: Record<string, string>) {
        if (!dependencies) return;

        for (let pkgName in dependencies) {
            let pkgInfos = infos[pkgName];

            if (pkgInfos) {
                let pkgVersion = isReverting ? pkgInfos.publicVersion : pkgInfos.version;

                changes.push(() => {
                    let newValue = gPackageManager.workspaceRefString;
                    if (isDetaching) newValue = "^" + pkgVersion;
                    if (mustForceUseOfLatest) newValue = "latest";
                    if (mustForceUseOfAny) newValue = "latest";

                    const newModif = modify(jsonText, [key, pkgName], newValue, {})
                    updated = updated ? updated.concat(newModif) : newModif;
                });
            }
        }
    }

    const changes: (() => void)[] = [];

    let jsonText = await fs.readFile(pkg.packageJsonFilePath, "utf-8");
    let json = JSON.parse(jsonText);

    if (json.jopiMono_MustIgnoreDependencies) {
        return;
    }

    const isReverting = mode === "reverting";
    const isDetaching = mode === "detach";
    const mustForceUseOfLatest = json.jopiMono_MustForceLatestVersion;
    const mustForceUseOfAny = json.jopiMono_MustForceAnyVersion;

    patch("dependencies", json.dependencies);
    patch("devDependencies", json.devDependencies);

    let updated: EditResult | undefined;

    if (changes.length) {
        changes.forEach(c => c());

        if (updated) {
            let output = applyEdits(jsonText, updated);
            await fs.writeFile(pkg.packageJsonFilePath, output);
        }
    }
}

async function setDependencies(infos: Record<string, PackageInfos>, isReverting = false) {
    for (let key in infos) {
        await setDependenciesFor(infos[key], infos, isReverting ? "reverting" : undefined);
    }
}

async function incrementVersions(packages: string[], pkgInfos: Record<string, PackageInfos>) {
    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!packages.includes(pkg.name)) continue;

        let version = pkg.version;

        if (!version) {
            console.warn("⚠️ " + pkg.name + " has no version number");
            continue;
        }

        let tag = "";

        if (version.includes("-")) {
            let idx = version.indexOf("-");
            tag = version.substring(idx);
            version = version.substring(0, idx);
        }

        let versionParts = version.split(".");
        let sRev = versionParts.pop()!;
        let sMinor = versionParts.pop()!;
        let sMajor = versionParts.pop()!;

        let newVersion = sMajor + "." + sMinor + "." + (parseInt(sRev) + 1) + tag;

        pkg.version_beforeIncr = pkg.version;
        pkg.version = newVersion;

        let jsonText = await fs.readFile(pkg.packageJsonFilePath, "utf-8");
        let updated = modify(jsonText, ["version"], newVersion, {});
        let output = applyEdits(jsonText, updated);

        await fs.writeFile(pkg.packageJsonFilePath, output);
    }
}

async function setUpdateDateAndPublicVersion(pkg: PackageInfos, isUsingPublicRegistry: boolean) {
    const theDate = new Date().toLocaleDateString();

    let jsonText = await fs.readFile(pkg.packageJsonFilePath, "utf-8");
    let updated = modify(jsonText, ["publicVersion"], pkg.publicVersion, {});
    updated = updated.concat(modify(jsonText, ["publishedDate"], theDate, {}));

    if (isUsingPublicRegistry) {
        updated = updated.concat(modify(jsonText, ["publicPublishedDate"], theDate, {}));
    }

    let output = applyEdits(jsonText, updated);

    await fs.writeFile(pkg.packageJsonFilePath, output);
}

//endregion

//region Commands

async function execToolRestoreBackup() {
    const pkgInfos = await findPackageJsonFiles();
    await restoreAllPackageJson(pkgInfos);
}

async function execToolCalcHash() {
    await deletePackageHashInfos();

    const pkgInfos = await findPackageJsonFiles();
    await loadPackageHashInfos(pkgInfos);
}

async function execToolSetDepVersion() {
    const pkgInfos = await findPackageJsonFiles();

    await backupAllPackageJson(pkgInfos);
    console.log("✅  Backup created.");

    await setDependencies(pkgInfos);
    console.log("✅  Versions updated.");
}

async function execPrintPackagesVersion() {
    const pkgInfos = await findPackageJsonFiles();
    await loadPublicVersionInfos(pkgInfos);

    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!pkg.isValidForPublish) continue;

        if (pkg.publicVersion) {
            if (pkg.publicVersion === pkg.version) {
                console.log((`✅  ${pkg.name}`).padEnd(30) + ` -> Local and public version: ${pkg.version}.`);
            } else {
                console.log((`🚫  ${pkg.name}`).padEnd(30) + ` -> Local version: ${pkg.version}. Public version: ${pkg.publicVersion}`);
            }
        } else {
            console.log((`😰  ${pkg.name}`).padEnd(30) + ` -> Local version: ${pkg.version}. Unpublished.`);
        }
    }
}

async function execCheckCommand() {
    const pkgInfos = await findPackageJsonFiles();
    await loadPackageHashInfos(pkgInfos);

    await detectUpdatedPackages(pkgInfos, {
        onPackageChecked: (needUpdate, pkg) => {
            if (needUpdate) console.log((`⚠️  ${pkg.name}`).padEnd(30) + ` -> change detected`);
            else console.log((`    ${pkg.name}`).padEnd(30) + ` -> is unchanged`);
        }
    });
}

async function packThisPackage(pkgInfos: PackageInfos, outputDir: string) {
    await jk_fs.mkDir(outputDir);

    let pkgDir = path.dirname(pkgInfos.packageJsonFilePath);
    let genFileName = pkgInfos.name + "-" + pkgInfos.version + ".tgz";
    let genFilePath = path.join(pkgDir, genFileName);

    execFileSync("npm", ["pack"], { stdio: 'inherit', cwd: pkgDir, shell: false });

    let finalFilePath = path.join(outputDir, genFileName);
    await fs.rename(genFilePath, finalFilePath);

    return finalFilePath;
}

async function execPackageCommand(params: { package: string, dir?: string }) {
    const pkgInfos = await findPackageJsonFiles();

    let thisPkgInfo = pkgInfos[params.package];

    if (!thisPkgInfo) {
        console.log("❌  The package " + params.package + " does not exist.");
        process.exit(1);
    }

    if (!params.dir) params.dir = "packageArchives";

    console.log("✅  Creating the package for", thisPkgInfo.name);
    let genFileName = await packThisPackage(thisPkgInfo, params.dir);
    console.log("✅  Created at", jk_fs.getRelativePath(process.cwd(), genFileName));
}

async function execPublishCommand(params: {
    packages: string[] | undefined,
    fake: boolean,
    noIncr: boolean,
    yes: boolean
}) {
    const isUsingPublicRegistry = gNpmRegistry === DEFAULT_NPM_REGISTRY;

    if (!params.yes && isUsingPublicRegistry) {
        const response = await jk_term.askYesNo("⚠️  It's will use the official npm repository. Do you want to continue?", true);

        if (!response) {
            console.log("❌  Canceled");
            process.exit(1);
        }
    }

    const pkgInfos = await findPackageJsonFiles();
    await loadPackageHashInfos(pkgInfos);

    let isFirst = false;

    const packagesToPublish = params.packages?.length ? params.packages : await detectUpdatedPackages(pkgInfos, {
        onPackageChecked: (_, pkg) => {
            if (isFirst) console.log();
            jk_term.consoleLogTemp(true, "Checking changes: " + pkg.name);
        }
    });

    for (let key of packagesToPublish) {
        let pkg = pkgInfos[key];

        if (!pkg) {
            console.log(`❌   Package ${key} not found.`);
            process.exit(1);
        }

        if (!pkg.isValidForPublish) {
            console.log(`❌   Package ${key} is not publishable.`);
            process.exit(1);
        }
    }

    if (!packagesToPublish.length) {
        console.log("Nothing to publish");
        return;
    }

    if (params.fake) {
        console.log("⚠️⚠️⚠️  Fake: backup  ⚠️⚠️⚠️");
        await backupAllPackageJson(pkgInfos);
    }

    if (!params.noIncr) {
        console.log("✅  Increase revision numbers.");
        await incrementVersions(packagesToPublish, pkgInfos);
    }

    let currentPackage: PackageInfos | undefined;
    let outputPackageDir = path.join(gCwd, "_tmpJopiMono");
    let script = "# Publishing packages.";
    script += "\n# -> Current registry: " + gNpmRegistry;
    script += "\n# -> Current user: " + gNpmUser
    script += "\n";
    script += "\n# You can change registry by doing:";
    script += "\n# --> Official one:";
    script += "\n#       npm config set registry https://registry.npmjs.org";
    script += "\n# --> Local Verdaccio:";
    script += "\n#       npm config set registry http://127.0.0.1:4873/";
    script += "\n";

    if (!option_directPublish) {
        await jk_fs.rmDir(outputPackageDir);
    }

    for (let key of packagesToPublish) {
        let pkg = pkgInfos[key];
        if (!pkg || !pkg.isValidForPublish) continue;
        currentPackage = pkg;

        console.log("✅  Fix dependencies version.");
        await setDependenciesFor(pkg, pkgInfos, "detach");

        console.log("✅  Set publish date.");
        await setUpdateDateAndPublicVersion(pkg, isUsingPublicRegistry);

        pkg.packageHash = await getPackage_latestModificationDate(pkg);
        const pkgRootDir = path.resolve(path.dirname(pkg.packageJsonFilePath));

        try {
            if (!option_directPublish) {
                script += `\n# Publish to version ${pkg.version}. Package: ${pkg.name}\n`;

                script += (await gPackageManager.createPublishScript({
                    packageInfos: pkg,
                    packageRootDir: pkgRootDir,
                    scriptTempDir: outputPackageDir,
                }));

                script += "\necho ✅  Published " + pkg.name + "\n";
            } else {
                if (!params.fake) {
                    await gPackageManager.publish(pkgRootDir);
                    await jk_timer.tick(100);
                }

                if (isUsingPublicRegistry) {
                    console.log((`✅  ${pkg.name}`).padEnd(30) + ` -> published. Version is now ${pkg.version} (was ${pkg.publicVersion ?? "unpublished"})`);
                } else {
                    console.log((`✅  ${pkg.name}`).padEnd(30) + ` -> published (private repo). Version is now ${pkg.version}`);
                }
            }

            if (isUsingPublicRegistry) {
                pkg.publicVersion = pkg.version;
            }

            console.log("✅  Restore dependencies to workspace version.");
            await setDependenciesFor(pkg, pkgInfos);
        } catch (error: any) {
            if (error.message.includes("409")) {
                console.log((`❌  ${pkg.name}`).padEnd(30) + ` -> conflict. Public version is already ${pkg.publicVersion}`);
            } else {
                console.log((`❌  ${pkg.name}`).padEnd(30) + ` -> error. Version ${pkg.version}`);
                console.log("     |- Error:", error.message);
            }

            if (currentPackage) {
                console.log("⚠️  Restoring package " + currentPackage.name + "...");
                await restoreThisPackage(currentPackage);
            }
        }
    }

    if (!option_directPublish) {
        script = "#!/usr/bin/env sh\n\n" + script;
        script += "\n# Deleting this temp dir"
        script += "\nrm -rf " + outputPackageDir
        script += "\n\n# In case of problem, do:\n# npx jopi-mono tool restore"
        let scriptPath = path.join(outputPackageDir, "publish.sh");
        await jk_fs.writeTextToFile(scriptPath, script);

        jk_term.logBgRed("🌟 Publish script generated at", scriptPath);
    }

    if (params.fake) {
        console.log("⚠️⚠️⚠️  Fake: restore  ⚠️⚠️⚠️");
        await restoreAllPackageJson(pkgInfos);
        console.log("✅  Restored");
    }

    process.exit(0);
}

async function execRevertCommand(params: {
    packages: string[] | undefined,
    fake: boolean
}) {
    const pkgInfos = await findPackageJsonFiles();
    const packages = params.packages || Object.keys(pkgInfos);

    await loadPublicVersionInfos(pkgInfos);
    let hasChanges = false;

    let reverted: string[] = [];

    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];

        if (!packages.includes(pkg.name)) continue;
        if (!pkg.publicVersion) continue;

        if (pkg.version === pkg.publicVersion) {
            console.log((`👍  ${pkg.name}`).padEnd(30) + ` -> is already the public version ${pkg.publicVersion}`);
            continue;
        }

        console.log((`✅  ${pkg.name}`).padEnd(30) + ` -> reverted from version ${pkg.version} to ${pkg.publicVersion}`);
        pkg.version = pkg.publicVersion;

        reverted.push(pkg.name);

        if (!params.fake) {
            let jsonText = await fs.readFile(pkg.packageJsonFilePath, "utf-8");
            let updated = modify(jsonText, ["version"], pkg.version, {});
            let output = applyEdits(jsonText, updated);

            hasChanges = true;
            await fs.writeFile(pkg.packageJsonFilePath, output);
        }
    }

    // Clean bun local cache.
    //
    if (hasChanges) {
        try {
            console.log("✅ Clearing cache.")
            await gPackageManager.cleanCache();
        } catch (e) {
            console.error("Can't clean local cache", e);
        }
    }

    if (reverted.length) {
        console.log("\n🎉  Packages reverted: ", reverted.join(", "));
    }
}

async function execInstallCommand() {
    try {
        console.log("✅  Installing dependencies...");
        await gPackageManager.install(gCwd)
        console.log("✅  Dependencies installed successfully.");
    } catch (error: any) {
        console.error("❌  Failed to install dependencies:", error.message);
        process.exit(1);
    }
}

async function execUpdateCommand() {
    try {
        console.log("✅  Updating dependencies...");
        gPackageManager.update(gCwd);
        console.log("✅  Dependencies updated successfully.");
    } catch (error: any) {
        console.error("❌  Failed to update dependencies:", error.message);
        process.exit(1);
    }
}

async function execWsAddCommand(params: {
    url: string,
    dir?: string
}) {
    async function getGitAccount(): Promise<string | undefined> {
        try {
            const packageJsonPath = path.join(gCwd, 'package.json');
            const content = await fs.readFile(packageJsonPath, 'utf8');
            const packageJson = JSON.parse(content);
            return packageJson["git-account"];
        } catch {
            return undefined;
        }
    }

    try {
        let repoUrl = params.url;
        let repoName: string;

        if (params.url.startsWith('http://') || params.url.startsWith('https://') || params.url.startsWith('git@')) {
            const urlParts = params.url.split('/');
            repoName = urlParts[urlParts.length - 1];

            if (repoName.endsWith('.git')) {
                repoName = repoName.slice(0, -4);
            }
        } else {
            repoName = params.url;
            const gitAccount = await getGitAccount();

            if (!gitAccount) {
                console.error("❌ No 'git-account' found in package.json. Please provide a full URL or add 'git-account' to your package.json.");
                process.exit(1);
            }

            repoUrl = `${gitAccount}/${repoName}`;
        }

        let targetDir = (params.dir || "packages") + "/" + repoName;

        console.log(`Cloning repository ${repoUrl} into ${targetDir}...`);

        try {
            execSync(`git clone ${repoUrl} ${targetDir}`, { stdio: 'pipe', cwd: gCwd });
            console.log(`✅  Repository cloned successfully into ${targetDir}.`);
        } catch (error: any) {
            // Afficher l'output seulement en cas d'erreur
            if (error.stdout) {
                console.log(error.stdout.toString());
            }
            if (error.stderr) {
                console.error(error.stderr.toString());
            }
            console.error("❌  Failed to clone repository:", error.message);
            process.exit(1);
        }

    } catch (error: any) {
        console.error("❌  Failed to clone repository:", error.message);
        process.exit(1);
    }

    await execToolSetDepVersion();
}

async function execWsDetachCommand(params: { package: string }) {
    const pkgInfos = await findPackageJsonFiles();
    let pkg = pkgInfos[params.package];

    if (!pkg) {
        console.error(`❌  Project ${params.package} not found.`);
        process.exit(1);
    }

    await setDependenciesFor(pkg, pkgInfos, "detach");
    console.log(`✅  Project ${params.package} has been detached.`);
}

async function execLinkAddPackage() {
    let pkgJsonFilePath = await searchPackageJsonFile();
    if (!pkgJsonFilePath) throw "package.json not found";

    let packageName = "";
    let pkgJson: any;

    try { pkgJson = JSON.parse(await jk_fs.readTextFromFile(pkgJsonFilePath, true)); }
    catch { throw `Invalid package.json (${pkgJsonFilePath})`; }
    //
    if (!pkgJson.name) throw "The package must have a name. See package.json";

    packageName = pkgJson.name;

    const homeDir = os.homedir();
    let configFile = jk_fs.join(homeDir, ".config", "jopi-mono", "link-packages.json");

    let config: any = {};

    if (await jk_fs.isFile(configFile)) {
        config = JSON.parse(await jk_fs.readTextFromFile(configFile));
    }

    config[packageName] = jk_fs.dirname(pkgJsonFilePath);
    await jk_fs.writeTextToFile(configFile, JSON.stringify(config, null, 4));

    console.log(`✅  Package ${jk_term.C_GREEN + packageName + jk_term.T_RESET} is now linked.`);
    console.log(`You can now use ${jk_term.C_BLUE}jopi-mono link-update ${packageName}${jk_term.T_RESET} to update it.`);

    let list = Object.keys(config).filter(x => x !== packageName);
    if (list.length) console.log(`Other available packages: ${jk_term.C_GREEN}${list.join(", ")}${jk_term.T_RESET}`);
}

async function execLinkUpdatePackage({ packageNames }: { packageNames: string[] }) {
    async function patchNpmDependencies(npmDepList: Record<string, string>) {
        let hasChanged = false;

        for (let depName in npmDepList) {
            let depVersion = npmDepList[depName];

            if (depVersion.startsWith("workspace:")) {
                let foundDir = await jk_app.findNodePackageDir(depName);

                if (foundDir) {
                    let targetPkgJson = await jk_fs.readJsonFromFile<IsPackageJson>(jk_fs.join(foundDir, "package.json"));

                    if (targetPkgJson) {
                        let version = targetPkgJson.version;

                        if (version) {
                            hasChanged = true;
                            npmDepList[depName] = version;
                        }
                    }
                }
            }
        }

        return hasChanged;
    }

    const homeDir = os.homedir();
    const configFile = jk_fs.join(homeDir, ".config", "jopi-mono", "link-packages.json");
    let config: any = {};

    if (await jk_fs.isFile(configFile)) {
        config = JSON.parse(await jk_fs.readTextFromFile(configFile));
    }

    for (let packageName of packageNames) {
        if (!config[packageName]) {
            console.error(`Package ${packageName} is not linked.\n> Use 'jopi-mono link-add' to link it for his directory.`);
            process.exit(1);
        }
    }

    const pkgJsonFilePath = await searchPackageJsonFile();
    //
    if (!pkgJsonFilePath) {
        console.error("package.json not found");
        process.exit(1);
    }

    const nodeModulesDir = jk_fs.join(jk_fs.dirname(pkgJsonFilePath), "node_modules");

    for (let packageName of packageNames) {
        let srcDir = config[packageName] as string;
        let dstDir = jk_fs.join(nodeModulesDir, packageName);

        if (nodeModulesDir.includes(srcDir + "/") || nodeModulesDir.includes(srcDir + "\\")) {
            console.error("The destination is inside the source directory. Please move it outside!.")
            process.exit(1);
        }

        // Case of a symlink link.
        try {
            await jk_fs.unlink(dstDir);
        } catch {
        }

        // Case of an existing directory.
        try {
            await jk_fs.rmDir(dstDir);
        } catch {
        }

        await jk_fs.copyDirectory(srcDir, dstDir);

        // Remove folders causing troubles.
        await jk_fs.rmDir(jk_fs.join(dstDir, ".git"));
        await jk_fs.rmDir(jk_fs.join(dstDir, ".turbo"));
        await jk_fs.rmDir(jk_fs.join(dstDir, "node_modules"));

        // Update .bin directory
        let pkgJson = await jk_fs.readJsonFromFile(jk_fs.join(srcDir, "package.json"))

        if (pkgJson.bin) {
            const binDir = jk_fs.join(nodeModulesDir, ".bin");
            await jk_fs.mkDir(binDir);

            if (typeof (pkgJson.bin) === "string") {
                let bin = pkgJson.bin;
                pkgJson.bin = {};
                pkgJson.bin[pkgJson.name] = bin;
            }

            for (let binName in pkgJson.bin) {
                let binFilePath = jk_fs.join(srcDir, pkgJson.bin[binName]);

                // Remove the current one.
                try { await jk_fs.unlink(jk_fs.join(binDir, binName)); } catch { }

                //console.log(`> Installing bin tool ${binName}: ${binFilePath} --> ${jk_fs.join(binDir, binName)}`)
                await jk_fs.symlink(binFilePath, jk_fs.join(binDir, binName));
            }
        }

        console.log(`✅  Package ${jk_term.C_GREEN + packageName + jk_term.T_RESET} has been updated.`);
    }

    // Update workspace:*
    //
    for (let packageName of packageNames) {
        let dstDir = jk_fs.join(nodeModulesDir, packageName);
        let pkgJson = await jk_fs.readJsonFromFile<IsPackageJson>(jk_fs.join(dstDir, "package.json"));

        let hasChanges = false;

        if (pkgJson.dependencies) {
            if (await patchNpmDependencies(pkgJson.dependencies)) {
                hasChanges = true;
            }
        }

        if (pkgJson.devDependencies) {
            if (await patchNpmDependencies(pkgJson.devDependencies)) {
                hasChanges = true;
            }
        }

        if (hasChanges) {
            await jk_fs.writeTextToFile(jk_fs.join(dstDir, "package.json"), JSON.stringify(pkgJson, null, 4));
        }
    }
}

//endregion

/**
 * Check if the user is authenticated with npm registry
 */
async function checkNpmAuth(): Promise<void> {
    // Warning, don't use old Yarn (v1,v2,v3) which is deprecated!
    try {
        gNpmUser = await gPackageManager.whoIAm();
        console.log(`🌟 Authenticated as: ${gNpmUser}`);
        return;
    } catch (e: any) {
        if (!e.message.includes("ENEEDAUTH")) console.log(e);
    }

    console.error(gPackageManager.helpAuth());
    process.exit(1);
}

function packageManagerError(packageManager: any) {
    console.error("Invalid package manager. Please use yarn or bun as package manager.")
    if (packageManager) console.error(`(found package manager:${packageManager.name}@${packageManager.version})`);
    process.exit(1);
}

async function selectPackageManagerDriver() {
    const packageManager = await findPackageManager();

    if (!packageManagerError) {
        packageManagerError(packageManager);
        return;
    }

    if (packageManager.name === "bun") {
        gPackageManager = new BunPackageManager();
    } else if (packageManager.name === "yarn") {
        if (packageManager.versionMajor < 3) {
            console.log("Please use yarn (>=v3) as package manager");
        }
        gPackageManager = new YarnPackageManager();
        //gPackageManager = new BunPackageManager();
    } else {
        packageManagerError(packageManager);
    }

    //console.log(`🔥 Package manager is ${gPackageManager.name} v${packageManager.versionMajor} 🔥`);
}

async function startUp() {
    await selectPackageManagerDriver();

    gNpmRegistry = await gPackageManager.getRegistryUrl();
    console.log("🌟 Registry URL:", gNpmRegistry);
    await checkNpmAuth();
    console.log();

    yargs(hideBin(process.argv))
        .command("check", "List packages which have changes since last publication.", () => { }, async () => {
            await execCheckCommand();
        })

        .command("publish [packages..]", "Publish all the packages with have changes since last publication.", (yargs) => {
            return yargs
                .positional('packages', {
                    type: 'string',
                    array: true,
                    describe: 'The packages to publish.',
                    demandOption: false,
                })
                .option('noincr', {
                    type: 'boolean',
                    default: false,
                    description: "Keep version as-is, without increasing revision number.",
                })
                .option('fake', {
                    type: 'boolean',
                    default: false,
                    description: "Don't really publish and revert all changes.",
                })
                .option('yes', {
                    type: 'boolean',
                    default: false,
                    description: "Confirm automatically the publication.",
                });
        }, async (argv) => {
            await execPublishCommand({
                packages: argv.packages as string[] | undefined,
                fake: argv.fake,
                noIncr: argv.noincr,
                yes: argv.yes
            });
        })

        .command("pack [package]", "Create a package a of repo", (yargs) => {
            return yargs
                .positional('package', {
                    type: 'string',
                    describe: 'The package to pack.',
                    demandOption: true,
                })
                .option('dir', {
                    type: 'string',
                    description: 'Target directory name',
                    demandOption: false
                });
        }, async (argv) => {
            await execPackageCommand({ package: argv.package as string, dir: argv.dir });
        })

        .command("versions-revert", "Revert package version number to the public version.", (yargs) => {
            return yargs
                .option('packages', {
                    type: 'array',
                    description: 'List of package to revert.',
                    demandOption: false,
                })
                .option('fake', {
                    type: 'boolean',
                    default: false,
                    description: "Don't really revert, only print messages.",
                });
        }, async (argv) => {
            await execRevertCommand({
                packages: argv.packages as string[] | undefined,
                fake: argv.fake
            });
        })

        .command("versions", "Print info about package versions.", () => { }, async () => {
            await execPrintPackagesVersion();
        })

        .command("install", "Install dependencies using bun install.", () => { }, async () => {
            await execInstallCommand();
        })

        .command("update", "Update dependencies using bun update.", () => { }, async () => {
            await execUpdateCommand();
        })

        .command("link-add", "Link the current package.", () => { }, async () => {
            await execLinkAddPackage();
        })

        .command("link-update <packageNames..>", "Update the linked packages in the current install.", (yargs) => {
            return yargs
                .positional('packageNames', {
                    type: 'string',
                    array: true,
                    describe: 'The packages to link.',
                    demandOption: true,
                });
        }, async (argv) => {
            await execLinkUpdatePackage({ packageNames: argv.packageNames });
        })

        .command("ws-add <url>", "Clone a git repository into the workspace.", (yargs) => {
            return yargs
                .positional('url', {
                    describe: 'Git repository URL or repository name (uses git-account from package.json)',
                    type: 'string',
                    demandOption: true
                })
                .option('dir', {
                    type: 'string',
                    description: 'Target directory name',
                    demandOption: true
                });
        }, async (argv) => {
            await execWsAddCommand({
                url: argv.url as string,
                dir: argv.dir as string | undefined
            });
        })

        .command("ws-detach <package>", "Detach a project, removing dependencies of type workspace.", (yargs) => {
            return yargs
                .positional('package', {
                    describe: 'The name of the package to detach',
                    type: 'string',
                    demandOption: true
                });
        }, async (argv) => {
            await execWsDetachCommand({
                package: argv.package as string
            });
        })

        .command("ws-remove <package>", "Alias for ws-detach.", (yargs) => {
            return yargs
                .positional('package', {
                    describe: 'The name of the package to detach',
                    type: 'string',
                    demandOption: true
                });
        }, async (argv) => {
            await execWsDetachCommand({
                package: argv.package as string
            });
        })

        .command("tool", "Internal tools, for special cases.", (yargs) => {
            yargs.command("restore", "Restore package.json backups.", () => { }, async () => {
                await execToolRestoreBackup();
            });

            yargs.command("calchash", "Cache the current packages hash.", () => { }, async () => {
                await execToolCalcHash();
            });

            yargs.command("setdepversion", "Set correct versions for workspace dependencies.", () => { }, async () => {
                await execToolSetDepVersion();
            });
        })

        .demandCommand(1, 'You must specify a valid command.')
        .version(VERSION).strict().help().parse();
}

interface CreatePublishScriptParams {
    packageInfos: PackageInfos,
    packageRootDir: string,
    scriptTempDir: string,
}

interface PackageManager {
    name: string;
    workspaceRefString: string;

    publish(cwd: string): Promise<void>;
    cleanCache(): Promise<void>;
    install(cwd: string): Promise<void>;
    update(cwd: string): Promise<void>;
    whoIAm(): Promise<string>;
    helpAuth(): string;
    createPublishScript(params: CreatePublishScriptParams): Promise<string>;

    getRegistryUrl(): Promise<string>;
}

class BunPackageManager implements PackageManager {
    readonly name = "bun";
    readonly workspaceRefString: string = "workspace:^";

    async publish(cwd: string) {
        execSync("npm publish --access public", { stdio: 'pipe', cwd });
    }

    async cleanCache() {
        execSync("bun pm cache rm");
    }

    async install(cwd: string) {
        execSync("bun install", { stdio: 'inherit', cwd });
    }

    async update(cwd: string) {
        execSync("bun update", { stdio: 'inherit', cwd });
    }

    async whoIAm(): Promise<string> {
        let r = execSync("bun pm whoami", { stdio: 'pipe', encoding: 'utf-8' });
        return r.toString().trim();
    }

    helpAuth(): string {
        return "❌  You are not authenticated with npm registry."
            + "\nPlease run 'npm login' or 'npm adduser' to authenticate before using this tool."
    }

    async createPublishScript(params: CreatePublishScriptParams): Promise<string> {
        let genFilePath = await packThisPackage(params.packageInfos, params.scriptTempDir);
        let fileName = jk_fs.basename(genFilePath);
        return `npm publish --access public ${fileName}`;
    }

    async getRegistryUrl(): Promise<string> {
        const homeDir = os.homedir();

        const npmrcPaths = [
            path.join(gCwd, NPM_CONFIG_FILE),
            path.join(homeDir, NPM_CONFIG_FILE)
        ];

        for (const configPath of npmrcPaths) {
            try {
                const content = await fs.readFile(configPath, 'utf8');
                const lines = content.split('\n');

                for (const line of lines) {
                    const [key, value] = line.split('=').map(s => s.trim());
                    if (key === 'registry') {
                        return value;
                    }
                }
            } catch {
            }
        }

        return DEFAULT_NPM_REGISTRY;
    }
}

class YarnPackageManager implements PackageManager {
    readonly name = "yarn";
    readonly workspaceRefString: string = "workspace:^";

    async publish(cwd: string) {
        // Don't use yarn npm publish since doesn't support piloted mode.
        execSync("yarn npm publish --access public", { stdio: 'pipe', cwd });
    }

    async cleanCache() {
        execSync("yarn cache clean");
    }

    async install(cwd: string) {
        execSync("yarn install", { stdio: 'inherit', cwd });
    }

    async update(cwd: string) {
        execSync("yarn up", { stdio: 'inherit', cwd });
    }

    async whoIAm(): Promise<string> {
        let r = execSync("yarn npm whoami", { stdio: 'pipe', encoding: 'utf-8' });
        let lines = r.toString().trim().split("\n");

        if (lines[0].includes("YN0000:")) {
            return lines[0].split("YN0000:")[1].trim();
        }

        throw new Error("ENEEDAUTH");
    }

    helpAuth(): string {
        return "❌  You are not authenticated with npm registry."
            + "\nPlease run 'yarn npm login' or 'yarn npm adduser' to authenticate before using this tool.";
    }

    async createPublishScript(params: CreatePublishScriptParams): Promise<string> {
        return `cd ${params.packageRootDir} && npm publish --access public`;
    }

    async getRegistryUrl(): Promise<string> {
        let r = execSync("yarn config get npmRegistryServer", { stdio: 'pipe', encoding: 'utf-8' });
        let url = r.toString().trim();

        if (url.split("\n").length > 1) {
            throw new Error(`Yarn can't get registry url`);
        }

        return url;
    }
}

const NPM_CONFIG_FILE = ".npmrc";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
let gPackageManager: PackageManager;

const gCwd = await searchWorkspaceDir();
let gNpmRegistry: string;
let gNpmUser: string;

/**
 * npm security isn't compatible with Yarn (npm whoami throws error, also npm publish).
 * For this reason, we create a script file to execute manually.
 */
const option_directPublish = false;

await startUp();

// ** Notes **
// npm view jopi-mono --registry http://localhost:4873/ version         --> Get "2.0.10"
// npm config set registry
