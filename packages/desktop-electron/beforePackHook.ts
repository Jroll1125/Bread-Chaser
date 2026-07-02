import { rebuild } from '@electron/rebuild';
import { Arch } from 'electron-builder';
import type { AfterPackContext } from 'electron-builder';

/* The beforePackHook runs before packing the Electron app for an architecture
We hook in here to build anything architecture dependent - such as better-sqlite3
To build, we call @electron/rebuild on the better-sqlite3 module.

bcrypt is deliberately NOT rebuilt here: bcrypt 6 ships ABI-stable N-API
prebuilds (prebuildify -> prebuilds/<platform>/bcrypt.node, loaded via
node-gyp-build) that run in Electron unchanged. @electron/rebuild cannot detect
those and would compile from source, which fails on machines without a C++
toolchain (e.g. Windows without MSVC). Packaging the existing prebuild is
correct and matches the `rebuild-electron` script's module list. */
const beforePackHook = async (context: AfterPackContext) => {
  const arch: string = Arch[context.arch];
  const buildPath = context.packager.projectDir;
  const projectRootPath = buildPath + '/../../';
  const electronVersion = context.packager.config.electronVersion;

  if (!electronVersion) {
    console.error('beforePackHook: Unable to find electron version.');
    process.exit(); // End the process - electron version is required
  }

  try {
    await rebuild({
      arch,
      buildPath,
      electronVersion,
      force: true,
      projectRootPath,
      onlyModules: ['better-sqlite3'],
    });

    console.info(`Rebuilt better-sqlite3 with ${arch}!`);
  } catch (err) {
    console.error('beforePackHook:', err);
    process.exit(); // End the process - unsuccessful build
  }
};

// oxlint-disable-next-line import/no-default-export
export default beforePackHook;
