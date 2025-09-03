import * as fs from "node:fs/promises";
import * as path from "node:path";
import {modify, applyEdits, type EditResult} from 'jsonc-parser';
import {execSync} from 'node:child_process';
import "jopi-node-space";

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const nFS = NodeSpace.fs;

interface PackageInfos {
    name: string;
    version: string;
    filePath: string;
    publicVersion?: string;
}

/**
 * Find all package.json from here.
 */
async function findPackageJsonFiles(dir: string, result: Record<string, PackageInfos> = {}): Promise<Record<string, PackageInfos>> {
    async function extractPackageInfos(filePath: string): Promise<PackageInfos> {
        let fileContent = await fs.readFile(filePath, "utf8");
        let pkgJson = JSON.parse(fileContent);
        let publicVersion: string|undefined;

        if (pkgJson.private!==true) {
            // Get the public version number of the package.
            //
            try {
                let sVersions = execSync(`npm view ${pkgJson.name} versions`, {stdio: 'pipe'}).toString();
                //
                sVersions = sVersions.replaceAll(`'`, `"`);
                let json = JSON.parse(sVersions);
                publicVersion = json.pop();
            } catch (error) {
                //console.log(`❌  Could get public version of ${pkgJson.name}`);
                publicVersion = undefined;
            }
        } else {
            console.log(`⚠️  Package ${pkgJson.name} is not public.`);
        }

        return {
            filePath,
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

        if (stats && stats.isFile() && stats.mtimeMs > (Date.now() - NodeSpace.timer.ONE_HOUR)) {
            let cacheFile = await nFS.readTextFromFile(path.join(dir, ".jopiMonoCache"));
            let json = JSON.parse(cacheFile);
            return json as Record<string, PackageInfos>;
        }
    }
    catch {
    }

    let res = await search(dir, result);
    await nFS.writeTextToFile(cacheFilePath, JSON.stringify(res, null, 2));

    return res;
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

        let jsonText = await fs.readFile(pkg.filePath, "utf-8");
        let updated = modify(jsonText, ["version"], newVersion, {});
        let output = applyEdits(jsonText, updated);
        if (!gArv.fake) await fs.writeFile(pkg.filePath, output);
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
            let output: Buffer<ArrayBufferLike>;

            try {
                output = execSync(PUBLISH_COMMAND, {stdio: 'pipe', cwd});
                console.log(`✅  ${pkg.name} published with success. Version ${pkg.version}. Public ${pkg.version}`);
            } catch (error: any) {
                console.log(`❌  can't publish ${pkg.name}. Version ${pkg.version}`, error.message);
                console.log("     |- Working dir:", cwd);
                console.log("     |- Commande:", PUBLISH_COMMAND);
                console.log("     |- Output:", output!.toString('utf8')
                );
            }
        } else if (gArv.fake) {
            console.log(`✅  (fake) ${pkg.name} published with success. Version ${pkg.version}`);
        }

        await NodeSpace.timer.tick(100);
    }
}

async function main() {
    gArv.cwd = path.resolve(gArv.cwd);

    let allPackages = gArv.allPackages;
    if (!gArv.packages) gArv.packages = [];

    let infos = await findPackageJsonFiles(gArv.cwd);

    if (allPackages || !gArv.packages.length) {
        gArv.allPackages = true;
        gArv.packages = Object.keys(infos);
    }
    else gArv.packages = gArv.packages.filter(pkgName => {
        if (!infos[pkgName]) {
            console.log(`❌  ${pkgName} not found`);
            return false;
        }

        return true;
    });

    if (gArv.versions) {
        await printVersions(gArv.packages, infos)
    } else {
        if (gArv.incrRev) {
            await incrementVersion(gArv.packages, infos);
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

let gArv: Argv;

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

parseCommandLineParams();
//console.log(gArv!);
main().then();