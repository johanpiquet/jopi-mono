import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {applyEdits, type EditResult, modify} from 'jsonc-parser';
import {execSync} from 'node:child_process';
import "jopi-node-space";

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

function saveCacheFile_json(fileName: string, content: any, options?: CacheFileOptions): Promise<void> {
    return saveCacheFile(fileName, JSON.stringify(content, null, 2), options);
}

async function getCacheFile(fileName: string, options?: CacheFileOptions): Promise<string|undefined> {
    let filePath = getCacheFilePath(fileName, options);

    try {
        return await NodeSpace.fs.readTextFromFile(filePath);
    }
    catch {
        return undefined;
    }
}

async function saveCacheFile(fileName: string, content: string, options?: CacheFileOptions): Promise<void> {
    let filePath = getCacheFilePath(fileName, options);
    await NodeSpace.fs.writeTextToFile(filePath, content);
}

//endregion

//region Backup

async function backupAllPackageJson(pkgInfos: Record<string, PackageInfos>) {
    async function backup(pkg: PackageInfos) {
        let targetFile = getCacheFilePath(pkg.name + ".json", {subDir: ["backup"]});
        let content = await NodeSpace.fs.readTextFromFile(pkg.packageJsonFilePath);
        await NodeSpace.fs.writeTextToFile(targetFile, content, true);
    }
    
    await Promise.all(Object.values(pkgInfos).map(async pkg => {
        await backup(pkg);
    }));
}

async function restoreAllPackageJson(pkgInfos: Record<string, PackageInfos>) {
    async function restore(pkg: PackageInfos) {
        let targetFile = getCacheFilePath(pkg.name + ".json", {subDir: ["backup"]});

        if (await NodeSpace.fs.isFile(targetFile)) {
            let content = await NodeSpace.fs.readTextFromFile(targetFile);
            await NodeSpace.fs.writeTextToFile(pkg.packageJsonFilePath, content, true);
        } else {
            console.log("No backup file found for", pkg.name, "can't restore");
        }
    }

    await Promise.all(Object.values(pkgInfos).map(async pkg => {
        await restore(pkg);
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

        let newHash = await getPackageCheckSum(pkg);

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

async function getPackageCheckSum(pkg: PackageInfos): Promise<string|undefined> {
    if (!pkg.isValidForPublish) return undefined;

    const cwd = path.dirname(pkg.packageJsonFilePath);

    try {
        const output = execSync('npm pack --dry-run --json', {stdio: 'pipe', cwd}).toString();
        const packInfo = JSON.parse(output);

        if (packInfo && packInfo.length > 0) {
            return packInfo[0].integrity;
        }
    } catch(e) {
        console.error(`❌  Failed to get package checksum for ${pkg.name}`, e);
    }

    return undefined;
}

async function loadPackageHashInfos(pkgInfos: Record<string, PackageInfos>) {
    const cacheFileName = "packages-hash.json";
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
            pkg.packageHash = await getPackageCheckSum(pkg);
            cache[pkg.name] = pkg.packageHash;
        }

        await saveCacheFile_json("packages-hash.json", cache);
    }
}

//endregion

//region Actions

async function setDependencies(infos: Record<string, PackageInfos>, isReverting = false, forceExactVersions = false) {
    async function patchPackage(pkg: PackageInfos, infos: Record<string, PackageInfos>) {
        function patch(key: string, dependencies: Record<string, string>) {
            if (!dependencies) return;

            for (let pkgName in dependencies) {
                let pkgInfos = infos[pkgName];

                if (pkgInfos) {
                    if (!isReverting) {
                        let currentVersion = dependencies[pkgName];

                        // Avoid updating the file if only the minor version has changed.
                        // Doing this will avoid updating the package.json if no dependency
                        // has a major / minor version update.
                        //
                        if (!forceExactVersions && currentVersion.startsWith("workspace:^")) {
                            let versionParts = pkgInfos.version.split(".");
                            let prefix = "workspace:^" + versionParts[0] + "." + versionParts[1] + ".";

                            if (currentVersion.startsWith(prefix)) {
                                continue;
                            }
                        }
                    }

                    changes.push(() => {
                        let version = isReverting ? pkgInfos.publicVersion : pkgInfos.version;
                        let newModif = modify(jsonText, [key, pkgName], "workspace:^" + version, {})
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

    for (let key in infos) {
        await patchPackage(infos[key], infos);
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

//endregion

//region Commands

async function execToolRestoreBackup() {
    const pkgInfos = await findPackageJsonFiles();
    await restoreAllPackageJson(pkgInfos);
}

async function execToolCalcHash() {
    const pkgInfos = await findPackageJsonFiles();
    await loadPackageHashInfos(pkgInfos);
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
    dontIncr: boolean
}) {
    const pkgInfos = await findPackageJsonFiles();
    await loadPackageHashInfos(pkgInfos);

    let isFirst = false;

    const packagesToPublish = params.packages || await detectUpdatedPackages(pkgInfos, {
        onPackageChecked: (_, pkg) => {
            if (isFirst) console.log();
            NodeSpace.term.consoleLogTemp(true, "Checking changes: " + pkg.name);
        }
    });

    if (!packagesToPublish.length) {
        console.log("Nothing to publish");
        return;
    }

    if (params.fake) {
        console.log("⚠️⚠️⚠️  Fake: backup  ⚠️⚠️⚠️");
        await backupAllPackageJson(pkgInfos);
    }

    if (!params.dontIncr) {
        console.log("✅  Increase revision numbers.");
        await incrementVersions(packagesToPublish, pkgInfos);
        await setDependencies(pkgInfos);
    }

    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!pkg.isValidForPublish) continue;
        if (!packagesToPublish.includes(pkg.name)) continue;

        const pkgRootDir = path.resolve(path.dirname(pkg.packageJsonFilePath));
        let isUsingPublicRegistry = gNpmRegistry === DEFAULT_NPM_REGISTRY;

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
        } catch (error: any) {
            if (error.message.includes("409")) {
                console.log((`❌  ${pkg.name}`).padEnd(30) + ` -> conflict. Public version is already ${pkg.publicVersion}`);
            } else {
                console.log((`❌  ${pkg.name}`).padEnd(30) + ` -> error. Version ${pkg.version}`);
                console.log("     |- Error:", error.message);
            }
        }

        pkg.packageHash = await getPackageCheckSum(pkg);

        await NodeSpace.timer.tick(100);
    }

    if (params.fake) {
        console.log("⚠️⚠️⚠️  Fake: restore  ⚠️⚠️⚠️");
        await restoreAllPackageJson(pkgInfos);
    }
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

    // Clean bun.js local cache.
    //
    if (hasChanges) {
        try {
            console.log("✅ Clearing bun.js cache.")
            execSync("bun pm cache rm");
        } catch (e) {
            console.error("Can't clean bun.js local cache", e);
        }
    }

    if (reverted.length) {
        console.log("\n🎉  Packages reverted: ", reverted.join(", "));
    }
}

//endregion

async function startUp() {
    yargs(hideBin(process.argv))
        .command("check", "List packages which have changes since last publish.", () => {}, async () => {
            await execCheckCommand();
        })
        .command("publish", "Publish packages.", (yargs) => {
            return yargs
                .option('no-incr', {
                    type: 'boolean',
                    default: false,
                    description: "Keep version as-is, without increasing revision number.",
                })
                .option('packages', {
                    type: 'array',
                    description: 'List of package to publish.',
                    demandOption: false,
                })
                .option('fake', {
                    type: 'boolean',
                    default: false,
                    description: "Don't really publish and revert all changes.",
                });
        }, async (argv) => {
            await execPublishCommand({
                packages: argv.packages as string[]|undefined,
                fake: argv.fake,
                dontIncr: argv.noIncr
            });
        })

        .command("revert", "Revert package version to public version.",  (yargs) => {
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

        .command("tool", "Internal tools, for special cases.", (yargs) => {
            yargs.command("restore", "Restore package.json backups.",  () => {}, async () => {
                await execToolRestoreBackup();
            });

            yargs.command("calchash", "Cache the current packages hash.",  () => {}, async () => {
                await execToolCalcHash();
            });
        })
        .demandCommand(1, 'You must specify a valid command.')
        .version("2.0").strict().help().parse();
}

const NPM_CONFIG_FILE = ".npmrc";
const PUBLISH_COMMAND = "bun publish --access public";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

const gCwd = await searchWorkspaceDir();
const gNpmRegistry = await getNpmConfig(gCwd);

await startUp();