import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {applyEdits, type EditResult, modify} from 'jsonc-parser';
import {execSync} from 'node:child_process';
import "jopi-node-space";

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const nFS = NodeSpace.fs;

interface PackageInfos {
    name: string;
    version: string;
    filePath: string;
    publicVersion?: string;
    checksum?: string;
    isPrivate: boolean;
    isValidForPublish: boolean;
}

/**
 * Find all package.json from here.
 */
async function findPackageJsonFiles(dir: string, result: Record<string, PackageInfos> = {}): Promise<Record<string, PackageInfos>> {
    async function extractPackageInfos(filePath: string): Promise<PackageInfos> {
        let fileContent = await fs.readFile(filePath, "utf8");
        let pkgJson = JSON.parse(fileContent);
        let publicVersion: string|undefined;

        let isValidForPublish = true;
        if (pkgJson.isPrivate) isValidForPublish = false;
        else if (!pkgJson.name) isValidForPublish = false;
        else if (!pkgJson.version) isValidForPublish = false;

        if (isValidForPublish) {
            // Get the public version number of the package.
            //
            try {
                const response = await fetch(`https://registry.npmjs.org/${pkgJson.name}`);

                if (response.ok) {
                    const packageData = await response.json();
                    const versions = Object.keys(packageData.versions || {});
                    publicVersion = versions.length > 0 ? versions[versions.length - 1] : undefined;
                } else {
                    publicVersion = undefined;
                }
            } catch (error) {
                //console.log(`❌  Can't get a public version of ${pkgJson.name}`);
                publicVersion = undefined;
            }
        } else {
            console.log(`⚠️  Package ${pkgJson.name} is not publishable.`);
        }

        return {
            filePath,
            isPrivate: pkgJson.private===true,
            isValidForPublish,
            name: pkgJson.name,
            version: pkgJson.version,
            publicVersion: publicVersion
        }
    }

    async function search(dir: string, result: Record<string, PackageInfos>) {
        const files = await fs.readdir(dir);

        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
                if (file !== 'node_modules') {
                    await search(fullPath, result);
                }
            } else if (file === 'package.json') {
                let infos = await extractPackageInfos(fullPath);
                result[infos.name] = infos;
            }
        }

        return result;
    }

    const cacheFilePath = path.join(dir, ".jopiMonoCache");

    try {
        let stats = await nFS.getFileStat(cacheFilePath);

        if (stats && stats.isFile()) {
            let cacheFile = await nFS.readTextFromFile(path.join(dir, ".jopiMonoCache"));
            let json = JSON.parse(cacheFile);

            if (json.registry===gNpmRegistry) {
                return json.packages as Record<string, PackageInfos>;
            }
        }
    }
    catch {
    }

    return await search(dir, result);
}

async function saveCache(pkgInfos: Record<string, PackageInfos>) {
    let data = {
        registry: gNpmRegistry,
        packages: pkgInfos
    };

    const cacheFilePath = path.join(gArv.cwd!, ".jopiMonoCache");
    await nFS.writeTextToFile(cacheFilePath, JSON.stringify(data, null, 2));
}

async function setDependencies(infos: Record<string, PackageInfos>, isReverting = false) {
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
                        if (!gArv.forceExactVersions && currentVersion.startsWith("workspace:^")) {
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

        let jsonText = await fs.readFile(pkg.filePath, "utf-8");
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
                await fs.writeFile(pkg.filePath, output);
            }
        }
    }

    for (let key in infos) {
        await patchPackage(infos[key], infos);
    }
}

async function incrementVersion(packages: string[], pkgInfos: Record<string, PackageInfos>) {
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
        pkg.version = newVersion;
        //console.log("Package", pkg.name, "is now version", pkg.version);

        let jsonText = await fs.readFile(pkg.filePath, "utf-8");
        let updated = modify(jsonText, ["version"], newVersion, {});
        let output = applyEdits(jsonText, updated);

        await fs.writeFile(pkg.filePath, output);
    }

    await saveCache(pkgInfos);
}

async function revertToPublicVersion(packages: string[], pkgInfos: Record<string, PackageInfos>) {
    let hasChanges = false;

    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (pkg.name==="jopi-rewrite") debugger;
        if (!packages.includes(pkg.name)) continue;
        if (!pkg.publicVersion) continue;

        let version = pkg.version;
        if (version === pkg.publicVersion) continue;

        console.log(`👍  Package ${pkg.name} reverted from ${pkg.version} to ${pkg.publicVersion}`);
        pkg.version = pkg.publicVersion;

        let jsonText = await fs.readFile(pkg.filePath, "utf-8");
        let updated = modify(jsonText, ["version"], pkg.version, {});
        let output = applyEdits(jsonText, updated);

        hasChanges = true;
        await fs.writeFile(pkg.filePath, output);
    }

    // Clean the local cache.
    //
    if (hasChanges) {
        try {
            execSync("bun pm cache rm");
        } catch (e) {
            console.error("Can't clean local cache", e);
        }
    }

    await saveCache(pkgInfos);
}

async function printVersions(packages: string[], pkgInfos: Record<string, PackageInfos>) {
    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!packages.includes(pkg.name)) continue;

        if (pkg.version) {
            console.log(`✅  Public version of ${pkg.name} is ${pkg.version}`);
        }
    }

    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!packages.includes(pkg.name)) continue;

        if (!pkg.version) {
            console.log(`👎  Package ${pkg.name} has no public version`);
        }
    }
}

async function publishPackages(packages: string[], pkgInfos: Record<string, PackageInfos>) {
    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!packages.includes(pkg.name)) continue;

        if (pkg.isValidForPublish) {
            const cwd = path.resolve(path.dirname(pkg.filePath));

            let oldPublicVersion = pkg.publicVersion;
            let isPublic = gNpmRegistry===DEFAULT_NPM_REGISTRY;

            try {
                if (!gArv.fake) {
                    if (isPublic) pkg.publicVersion = pkg.version;
                    execSync(PUBLISH_COMMAND, {stdio: 'pipe', cwd});
                }

                let fakePrefix = gArv.fake ? "✅  [FAKE]" : "✅ ";

                if (isPublic) {
                    console.log(fakePrefix, `${pkg.name} published publicly with success. Version ${oldPublicVersion} -> ${pkg.version}.`);
                }
                else {
                    console.log(fakePrefix, `${pkg.name} published privately with success. Private version ${pkg.version}, public ${oldPublicVersion || "(not published)"}`);
                }
            } catch (error: any) {
                if (error.message.includes("409")) {
                    console.log(`❌  Version conflict when publishing ${pkg.name}. Version ${pkg.version}`);
                } else {
                    console.log(`❌  Can't publish ${pkg.name}. Version ${pkg.version}`);
                    console.log("     |- Working dir:", cwd);
                    console.log("     |- Error:", error.message);
                }
            }
        }

        pkg.checksum = await getPackageCheckSum(pkg);

        await NodeSpace.timer.tick(100);
    }

    await saveCache(pkgInfos);
}

async function getPackageCheckSum(pkg: PackageInfos): Promise<string|undefined> {
    if (!pkg.isValidForPublish) return undefined;

    const cwd = path.dirname(pkg.filePath);

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

/**
 * Return a list of packages which content is updated.
 * Which means that if doing a dry-run, then
 */
async function detectUpdatedPackages(pkgInfos: Record<string, PackageInfos>): Promise<string[]> {
    const updatedPackages: string[] = [];

    for (const key in pkgInfos) {
        const pkg = pkgInfos[key];
        let checksum = await getPackageCheckSum(pkg);

        if (checksum && (pkg.checksum !== checksum)) {
            updatedPackages.push(pkg.name);
        }
    }

    return updatedPackages;
}

async function main() {
    await parseCommandLineParams();
    
    gNpmRegistry = await getNpmConfig();
    let allPackages = gArv.allPackages;
    let pkgInfos = await findPackageJsonFiles(gArv.cwd!);

    let mustAutoSelectPackaged = allPackages || !gArv.packages.length;

    if (mustAutoSelectPackaged) {
        gArv.allPackages = true;
        gArv.packages = Object.keys(pkgInfos);
    }

    if (gArv.versions) {
        await printVersions(gArv.packages, pkgInfos)
    } if (gArv.revertPublicVersion) {
        await revertToPublicVersion(gArv.packages, pkgInfos);
        await setDependencies(pkgInfos, true);
        return;
    }
    else {
        if (mustAutoSelectPackaged) {
            gArv.packages = await detectUpdatedPackages(pkgInfos);
        }
        else {
            gArv.packages = gArv.packages.filter(pkgName => {
                if (!pkgInfos[pkgName]) {
                    console.log(`❌  ${pkgName} not found`);
                    return false;
                }

                return true;
            });
        }

        if (!gArv.packages.length) {
            console.log("🛑  No packages needing update. Quit. 🛑");
        }

        let mustSetDependencies = false;

        if (gArv.incrRev) {
            await incrementVersion(gArv.packages, pkgInfos);
            mustSetDependencies = true;
        }

        if (mustSetDependencies) {
            await setDependencies(pkgInfos);
        }

        if (gArv.publish) {
            await publishPackages(gArv.packages, pkgInfos);
        }
    }
}

// Interface for the parsed arguments
interface Argv {
    // > Datas

    packages: string[];
    allPackages: boolean;
    cwd?: string;

    // > Commandes

    incrRev: boolean;
    revertPublicVersion: boolean;
    publish: boolean;
    versions: boolean;
    fake: boolean;

    forceExactVersions: boolean;
}

async function parseCommandLineParams() {
    gArv = yargs(hideBin(process.argv))
        .option('publish', {
            type: 'boolean',
            default: false,
            description: 'Ask to publish the packages.',
            demandOption: false, // Not required
        })
        .option('packages', {
            type: 'array',
            default: [],
            description: 'A list of workspace packages to used.',
            demandOption: false, // Not required
        })
        .option('all-packages', {
            type: 'boolean',
            default: false,
            description: 'Allow to use all workspace packages.',
            demandOption: false, // Not required
        })
        .option('publish-all', {
            type: 'boolean',
            default: false,
            description: 'Allow publish all packages.',
            demandOption: false, // Not required
        })
        .option("versions", {
            type: 'boolean',
            default: false,
            description: 'Print the public version of all packages.',
            demandOption: false, // Not required
        })
        .option("force-exact-versions", {
            type: 'boolean',
            default: false,
            description: 'Allow forcing exact version matching in package.json.',
            demandOption: false, // Not required
        })
        .option("revert-public-version", {
            type: 'boolean',
            default: false,
            description: 'Revert the version number to the public version number.',
            demandOption: false, // Not required
        })
        .option('incr-rev', {
            type: 'boolean',
            default: false,
            description: 'A list of package names for which to increment the revision version.',
            demandOption: false, // Not required
        })
        .option("fake", {
            type: 'boolean',
            default: false,
            description: "Don't do real changes on the registry, will only update local files.",
        })
        .strict() // Reject unrecognized arguments
        .parse() as Argv;

    gArv.cwd = await searchWorkspaceDir();

    if (!gArv.cwd) {
        console.log("Error: no workspace found");
        process.exit(1);
    }

    if (!gArv.allPackages && !gArv.packages.length) {
        gArv.allPackages = true;
    }

    if (gArv.publish) {
        gArv.incrRev = true;
    }

    gArv.cwd = path.resolve(gArv.cwd);
    if (!gArv.packages) gArv.packages = [];
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
            // Continue if file doesn't exist or can't be parsed
        }

        currentDir = path.dirname(currentDir);
    }

    return process.cwd();
}

async function getNpmConfig(): Promise<string> {
    const homeDir = os.homedir();

    const npmrcPaths = [
        path.join(gArv.cwd!, NPM_CONFIG_FILE),
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


const PUBLISH_COMMAND = "bun publish --access public";
const NPM_CONFIG_FILE = ".npmrc";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

let gArv: Argv;
let gNpmRegistry: string;

main().then();