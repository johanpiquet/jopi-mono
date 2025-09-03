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
            return json as Record<string, PackageInfos>;
        }
    }
    catch {
    }

    let res = await search(dir, result);
    await saveCache(res);

    return res;
}

async function saveCache(infos: Record<string, PackageInfos>) {
    const cacheFilePath = path.join(gArv.cwd, ".jopiMonoCache");
    await nFS.writeTextToFile(cacheFilePath, JSON.stringify(infos, null, 2));
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
        if (!gArv.fake) await fs.writeFile(pkg.filePath, output);
    }
}

async function setDependencies(infos: Record<string, PackageInfos>) {
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

        if (!gArv.fake) {
            await fs.writeFile(pkg.filePath, output);
        }
    }

    if (!gArv.fake) {
        await saveCache(pkgInfos);
    }
}

async function revertToPublicVersion(packages: string[], pkgInfos: Record<string, PackageInfos>) {
    let hasChanges = false;

    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!packages.includes(pkg.name)) continue;
        if (!pkg.publicVersion) continue;

        let version = pkg.version;
        if (version === pkg.publicVersion) continue;

        console.log(`👍  Package ${pkg.name} reverted from ${pkg.version} to ${pkg.publicVersion}`);
        pkg.version = pkg.publicVersion;

        let jsonText = await fs.readFile(pkg.filePath, "utf-8");
        let updated = modify(jsonText, ["version"], pkg.version, {});
        let output = applyEdits(jsonText, updated);

        if (!gArv.fake) {
            hasChanges = true;
            await fs.writeFile(pkg.filePath, output);
        }
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

    if (!gArv.fake) {
        await saveCache(pkgInfos);
    }
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

async function publishPackage(packages: string[], pkgInfos: Record<string, PackageInfos>) {
    for (let key in pkgInfos) {
        let pkg = pkgInfos[key];
        if (!packages.includes(pkg.name)) continue;

        if (pkg.version && !gArv.fake) {
            const cwd = path.resolve(path.dirname(pkg.filePath));

            let oldPublicVersion = pkg.publicVersion;
            let isPublic = gNpmRegistry===DEFAULT_NPM_REGISTRY;

            if (isPublic) {
                pkg.publicVersion = pkg.version;
            }

            try {
                execSync(PUBLISH_COMMAND, {stdio: 'pipe', cwd});

                if (isPublic) {
                    console.log(`✅  ${pkg.name} published publicly with success. Version ${oldPublicVersion} -> ${pkg.version}.`);
                }
                else {
                    console.log(`✅  ${pkg.name} published privately with success. Private version ${pkg.version}, public ${oldPublicVersion || "(not published)"}`);
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
        } else if (gArv.fake) {
            console.log(`✅  (fake) ${pkg.name} published with success. Version ${pkg.version}`);
        }

        pkg.checksum = await getPackageCheckSum(pkg);

        await NodeSpace.timer.tick(100);
    }

    if (!gArv.fake) {
        await saveCache(pkgInfos);
    }
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
            //pkg.checksum = checksum;
            updatedPackages.push(pkg.name);
            //console.log(pkg.name, "is selected");
        }
    }

    if (!gArv.fake) {
        await saveCache(pkgInfos);
    }

    return updatedPackages;
}

async function main() {
    gArv.cwd = path.resolve(gArv.cwd);
    gNpmRegistry = await getNpmConfig();

    let allPackages = gArv.allPackages;
    if (!gArv.packages) gArv.packages = [];

    let infos = await findPackageJsonFiles(gArv.cwd);

    if (allPackages || !gArv.packages.length) {
        gArv.allPackages = true;
        gArv.packages = await detectUpdatedPackages(infos)
    }
    else {
        gArv.packages = gArv.packages.filter(pkgName => {
            if (!infos[pkgName]) {
                console.log(`❌  ${pkgName} not found`);
                return false;
            }

            return true;
        });
    }

    if (gArv.versions) {
        await printVersions(gArv.packages, infos)
    } else {
        let mustSetDependencies = false;

        if (gArv.revertPublicVersion) {
            await revertToPublicVersion(gArv.packages, infos);
            mustSetDependencies = true;
        }

        if (gArv.incrRev) {
            await incrementVersion(gArv.packages, infos);
            mustSetDependencies = true;
        }

        if (mustSetDependencies) {
            await setDependencies(infos);
        }

        if (gArv.publish) {
            await publishPackage(gArv.packages, infos);
        }
    }
}

// Interface for the parsed arguments
interface Argv {
    // > Datas

    packages: string[];
    allPackages: boolean;
    cwd: string;

    // > Commandes

    incrRev: boolean;
    revertPublicVersion: boolean;
    publish: boolean;
    versions: boolean;
    fake: boolean;
}

function parseCommandLineParams() {
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
        .option("cwd", {
            description: "Allow forcing the current working directory",
            default: process.cwd()
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
            description: "Don't do real changes, will only test.",
        })
        .strict() // Reject unrecognized arguments
        .parse() as Argv;
}

const PUBLISH_COMMAND = "bun publish";
const NPM_CONFIG_FILE = ".npmrc";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

async function getNpmConfig(): Promise<string> {
    const homeDir = os.homedir();

    const npmrcPaths = [
        path.join(gArv.cwd, NPM_CONFIG_FILE),
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

let gArv: Argv;
let gNpmRegistry: string;

parseCommandLineParams();
//console.log(gArv!);
main().then();