import { readdir, readFile } from 'node:fs/promises'

const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (!semver.test(root.version)) throw new Error(`root version is not SemVer: ${root.version}`)

const workspaceRoots = ['apps', 'packages']
const packages = []
for (const workspaceRoot of workspaceRoots) {
  const base = new URL(`../${workspaceRoot}/`, import.meta.url)
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packagePath = new URL(`../${workspaceRoot}/${entry.name}/package.json`, import.meta.url)
    try {
      packages.push(JSON.parse(await readFile(packagePath, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

const internal = new Set(packages.map((pkg) => pkg.name))
for (const pkg of packages) {
  if (pkg.version !== root.version) {
    throw new Error(`${pkg.name} version ${pkg.version} does not match root ${root.version}`)
  }
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ]) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (internal.has(name) && range !== root.version && range !== 'workspace:*') {
        throw new Error(
          `${pkg.name} ${section}.${name}=${range} must equal ${root.version} or workspace:*`
        )
      }
    }
  }
}

console.log(`version ${root.version}: ${packages.length} workspaces synchronized`)
