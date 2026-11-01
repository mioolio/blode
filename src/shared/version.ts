import { version, releaseVersion } from '../../package.json';

/** Public four-part release identifier; npm retains its SemVer package version. */
export const RELEASE_VERSION = releaseVersion ?? version;
