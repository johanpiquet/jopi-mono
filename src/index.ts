import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {applyEdits, type EditResult, modify} from 'jsonc-parser';
import {execSync} from 'node:child_process';
import NodeSpace, {nFS} from "jopi-node-space";

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

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

//region Cache

let gCacheDir: string|undefined;

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

async function getCacheFile_json<T>(fileName: string, options?: CacheFileOptions): Promise<T|undefined> {
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
    await nFS.unlink(filePath);
}

function saveCacheFile_json(fileName: string, content: any, options?: CacheFileOptions): Promise<void> {
    return saveCacheFile(fileName, JSON.stringify(content, null, 2), options);
}

async function getCacheFile(fileName: string, options?: CacheFileOptions): Promise<string|undefined> {
    let filePath = getCacheFilePath(fileName, options);

    try {
        return await nFS.readTextFromFile(filePath);
    }
    catch {
        return undefined;
    }
}

async function saveCacheFile(fileName: string, content: string, options?: CacheFileOptions): Promise<void> {
    let filePath = getCacheFilePath(fileName, options);
    await nFS.writeTextToFile(filePath, content);
}

//endregion

//region Backup

async function backupAllPackageJson(pkgInfos: Record<string, PackageInfos>) {
    async function backup(pkg: PackageInfos) {
        let targetFile = getCacheFilePath(pkg.name + ".json", {subDir: ["backup"]});
        let content = await nFS.readTextFromFile(pkg.packageJsonFilePath);
        await nFS.writeTextToFile(targetFile, content, true);
    }
    
    await Promise.all(Object.values(pkgInfos).map(async pkg => {
        await backup(pkg);
    }));
}

async function restoreThisPackage(pkg: PackageInfos) {
    let targetFile = getCacheFilePath(pkg.name + ".json", {subDir: ["backup"]});

    if (await nFS.isFile(targetFile)) {
        let content = await nFS.readTextFromFile(targetFile);
        await nFS.writeTextToFile(pkg.packageJsonFilePath, content, true);
    } else {
        console.log("No backup file found for", pkg.name, "can't restore");
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
    onPackageChecked?: (hasChangeDetect: boolean, pkg: PackageInfos)=>void;
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

/**
 * Get information about the ".npmrc" file.
 * @param cwd
 */
async function getNpmConfig(cwd: string): Promise<string> {
    const homeDir = os.homedir();

    const npmrcPaths = [
        path.join(cwd, NPM_CONFIG_FILE),
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
            isPrivate: pkgJson.private===true,
        }
    }

    async function searchInDirectories(dir: string, result: Record<string, PackageInfos>) {
        const files = await fs.readdir(dir);

        if (files.includes(".jopiMonoIgnore")) {
            return result;
        }

        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
                if (file !== 'node_modules') {
                    await searchInDirectories(fullPath, result);
                }
            } else if (file === 'package.json') {
                let infos = await extractPackageInfos(fullPath);
                result[infos.name] = infos;
            }
        }

        return result;
    }

    return await searchInDirectories(gCwd, {});
}

async function getPackage_latestModificationDate(pkg: PackageInfos): Promise<string|undefined> {
    async function scanDirectories(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name[0]==='.') continue;

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

            NodeSpace.term.consoleLogTemp(true, `Calculating hash for ${pkg.name}`);
            pkg.packageHash = await getPackage_latestModificationDate(pkg);
            cache[pkg.name] = pkg.packageHash;
        }

        await saveCacheFile_json("packages-hash.json", cache);
    }
}

const cacheFileName = "packages-hash.json";

//endregion

//region Actions

async function setDependenciesFor(pkg: PackageInfos, infos: Record<string, PackageInfos>, mode?: undefined|"reverting"|"detach") {
    function patch(key: string, dependencies: Record<string, string>) {
        if (!dependencies) return;

        for (let pkgName in dependencies) {
            let pkgInfos = infos[pkgName];

            if (pkgInfos) {
                let pkgVersion = isReverting ? pkgInfos.publicVersion : pkgInfos.version;

                changes.push(() => {
                    let newValue = "workspace:^";
                    if (isDetaching) newValue = "^" + pkgVersion;
                    if (mustForceUseOfLatest) newValue = "latest";
                    if (mustForceUseOfAny) newValue = "latest";

                    const newModif = modify(jsonText, [key, pkgName], newValue, {})
                    updated = updated ? updated.concat(newModif) : newModif;
                });
            }
        }
    }

    const changes: (()=>void)[] = [];

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
            if (needUpdate) console.log((`⚠️  ${pkg.name}`).padEnd(30) +  ` -> change detected`);
            else console.log((`    ${pkg.name}`).padEnd(30) +  ` -> is unchanged`);
        }
    });
}

async function execPublishCommand(params: {
    packages: string[]|undefined,
    fake: boolean,
    noIncr: boolean,
    yes: boolean
}) {
    const isUsingPublicRegistry = gNpmRegistry === DEFAULT_NPM_REGISTRY;

    if (!params.yes && isUsingPublicRegistry) {
        const response = await NodeSpace.term.askYesNo("⚠️  It's will use the official npm repository. Do you want to continue?", true);

        if (!response) {
            console.log("❌  Canceled");
            process.exit(0);
        }
    }

    await checkNpmAuth();

    const pkgInfos = await findPackageJsonFiles();
    await loadPackageHashInfos(pkgInfos);

    let isFirst = false;

    const packagesToPublish = params.packages?.length ? params.packages : await detectUpdatedPackages(pkgInfos, {
        onPackageChecked: (_, pkg) => {
            if (isFirst) console.log();
            NodeSpace.term.consoleLogTemp(true, "Checking changes: " + pkg.name);
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

    let currentPackage: PackageInfos|undefined;

    for (let key of packagesToPublish) {
        let pkg = pkgInfos[key];
        if (!pkg || !pkg.isValidForPublish) continue;
        currentPackage = pkg;

        console.log("✅  Update dependencies to neutral version.");
        await setDependenciesFor(pkg, pkgInfos, "detach");

        console.log("✅  Set publish date.");
        await setUpdateDateAndPublicVersion(pkg, isUsingPublicRegistry);

        const pkgRootDir = path.resolve(path.dirname(pkg.packageJsonFilePath));

        try {
            if (!params.fake) {
                execSync(PUBLISH_COMMAND, {stdio: 'pipe', cwd: pkgRootDir});
            }

            if (isUsingPublicRegistry) {
                console.log((`✅  ${pkg.name}`).padEnd(30) + ` -> published. Version is now ${pkg.version} (was ${pkg.publicVersion})`);
                pkg.publicVersion = pkg.version;
            } else {
                console.log((`✅  ${pkg.name}`).padEnd(30) + ` -> published (private repo). Version is now ${pkg.version}`);
            }

            if (isUsingPublicRegistry) pkg.publicVersion = pkg.version;

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

        pkg.packageHash = await getPackage_latestModificationDate(pkg);

        await NodeSpace.timer.tick(100);
    }

    if (params.fake) {
        console.log("⚠️⚠️⚠️  Fake: restore  ⚠️⚠️⚠️");
        await restoreAllPackageJson(pkgInfos);
        console.log("✅  Restored");
    }

    process.exit(0);
}

async function execRevertCommand(params: {
    packages: string[]|undefined,
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
            console.log("✅ Clearing bun cache.")
            execSync(COMMAND_CLEAN_CACHE__BUN);
            console.log("✅ Clearing node cache.")
            execSync(COMMAND_CLEAN_CACHE__NODE);
        } catch (e) {
            console.error("Can't clean bun local cache", e);
        }
    }

    if (reverted.length) {
        console.log("\n🎉  Packages reverted: ", reverted.join(", "));
    }
}

async function execInstallCommand() {
    try {
        console.log("✅  Installing dependencies with bun...");
        execSync(COMMAND_INSTALL, {stdio: 'inherit', cwd: gCwd});
        console.log("✅  Dependencies installed successfully.");
    } catch (error: any) {
        console.error("❌  Failed to install dependencies:", error.message);
        process.exit(1);
    }
}

async function execUpdateCommand() {
    try {
        console.log("✅  Updating dependencies with bun...");
        execSync(COMMAND_UPDATE, {stdio: 'inherit', cwd: gCwd});
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

        let targetDir = params.dir;
        if (!targetDir) targetDir = `packages/${repoName}`;

        console.log(`Cloning repository ${repoUrl} into ${targetDir}...`);
        
        try {
            execSync(`git clone ${repoUrl} ${targetDir}`, {stdio: 'pipe', cwd: gCwd});
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

//endregion

/**
 * Check if the user is authenticated with npm registry
 */
async function checkNpmAuth(): Promise<void> {
    try {
        const _result = execSync(COMMAND_WHOIAM, { stdio: 'pipe', cwd: gCwd });
        console.log(`✅  Authenticated as: ${_result.toString().trim()}`);
        return;
    } catch {
    }

    console.error("❌  You are not authenticated with npm registry.");
    console.error("Please run 'bun npm login' to authenticate before using this tool.");
    process.exit(1);
}

async function startUp() {
    yargs(hideBin(process.argv))
        .command("check", "List packages which have changes since last publication.", () => {}, async () => {
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
                packages: argv.packages as string[]|undefined,
                fake: argv.fake,
                noIncr: argv.noincr,
                yes: argv.yes
            });
        })

        .command("revert", "Revert package version number to the public version.",  (yargs) => {
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
                packages: argv.packages as string[]|undefined,
                fake: argv.fake
            });
        })

        .command("versions", "Print info about package versions.",  () => {}, async () => {
            await execPrintPackagesVersion();
        })

        .command("install", "Install dependencies using bun install.", () => {}, async () => {
            await execInstallCommand();
        })

        .command("update", "Update dependencies using bun update.", () => {}, async () => {
            await execUpdateCommand();
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
                    demandOption: false
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
            yargs.command("restore", "Restore package.json backups.",  () => {}, async () => {
                await execToolRestoreBackup();
            });

            yargs.command("calchash", "Cache the current packages hash.",  () => {}, async () => {
                await execToolCalcHash();
            });

            yargs.command("setdepversion", "Set correction versions for workspace dependencies.",  () => {}, async () => {
                await execToolSetDepVersion();
            });
        })

        .demandCommand(1, 'You must specify a valid command.')
        .version("2.1").strict().help().parse();
}

const NPM_CONFIG_FILE = ".npmrc";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

const PUBLISH_COMMAND = "npm publish --access public";
const COMMAND_CLEAN_CACHE__BUN = "bun pm cache rm";
const COMMAND_CLEAN_CACHE__NODE = "npm cache clean --force";
const COMMAND_INSTALL = "bun install";
const COMMAND_UPDATE = "bun update";
const COMMAND_WHOIAM = "npm whoami";
const COMMAND_DRY_RUN = "npm publish --dry-run --json";

const gCwd = await searchWorkspaceDir();
const gNpmRegistry = await getNpmConfig(gCwd);

await startUp();
