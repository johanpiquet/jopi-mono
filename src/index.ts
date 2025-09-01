import * as fs from "node:fs/promises";
import * as path from "node:path";
import {modify, applyEdits, type EditResult} from 'jsonc-parser';
import {execSync} from 'node:child_process';
import "jopi-node-space";

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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
        if (!FAKE) await fs.writeFile(pkg.filePath, output);
    }
}

async function setDependencies(infos: Record<string, PackageInfos>) {
    for (let key in infos) {
        await patchPackage(infos[key], infos);
    }
}

async function incrementVersion(mustIncr: string[], incrAll: boolean, infos: Record<string, PackageInfos>) {
    for (let key in infos) {
        let pkg = infos[key];

        if (!incrAll) {
            if (!mustIncr.includes(pkg.name)) {
                continue;
            }
        }

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
        if (!FAKE) await fs.writeFile(pkg.filePath, output);
    }
}

async function publishPackage(mustPublish: string[], publishAll: boolean, infos: Record<string, PackageInfos>) {
    for (let key in infos) {
        let pkg = infos[key];
        if (!publishAll) {
            if (!mustPublish.includes(pkg.name)) {
                continue;
            }
        }

        if (pkg.version && !FAKE) {
            const cwd = path.resolve(path.dirname(pkg.filePath));
            let output: Buffer<ArrayBufferLike>;

            try {
                output = execSync(PUBLISH_COMMAND, {stdio: 'pipe', cwd});
                console.log(`✅  ${pkg.name} published with success. Version ${pkg.version}`);
            } catch (error: any) {
                console.log(`❌  can't publish ${pkg.name}. Version ${pkg.version}`, error.message);
                console.log("     |- Working dir:", cwd);
                console.log("     |- Commande:", PUBLISH_COMMAND);
                console.log("     |- Output:", output!.toString('utf8')
                );
            }
        } else if (FAKE) {
            console.log(`✅  (fake) ${pkg.name} published with success. Version ${pkg.version}`);
        }

        await NodeSpace.timer.tick(100);
    }
}

async function exec() {
    let processAll = false;
    if (!gArv.publish) gArv.publish = ["*"];

    if (gArv.publish.length) {
        processAll = gArv.publish[0] === "*";
        if (processAll) gArv.publish = [];
    }
    else {
        return;
    }

    let infos = await findPackageJsonFiles();

    gArv.publish = gArv.publish.filter(pkgName => {
        if (!infos[pkgName]) {
            console.log(`❌  ${pkgName} not found`);
            return false;
        }

        return true;
    });

    if (gArv.incrRev) await incrementVersion(gArv.publish, processAll, infos);
    await setDependencies(infos);
    await publishPackage(gArv.publish, processAll, infos);
}

// Interface for the parsed arguments
interface Argv {
    publish: string[];
    incrRev: boolean;
}

let gArv: Argv;
const FAKE = false;

function parseCommandLineParams() {
    gArv = yargs(hideBin(process.argv))
        .option('publish', {
            alias: 'p',
            type: 'array',
            description: 'A list of NPM package names to publish.',
            demandOption: false, // Not required
        })
        .option('incr-rev', {
            alias: 'r',
            type: 'boolean',
            default: true,
            description: 'A list of package names for which to increment the revision version.',
            demandOption: false, // Not required
        })
        .strict() // Reject unrecognized arguments
        .parse() as Argv;
}

const PUBLISH_COMMAND = "bun publish";

parseCommandLineParams();
exec().then();