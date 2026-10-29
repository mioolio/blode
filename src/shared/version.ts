import manifest from '../../package.json';

const metadata: { version: string; releaseVersion?: string } = manifest;

/** Public four-part release identifier; npm retains its SemVer package version. */
export const RELEASE_VERSION = metadata.releaseVersion ?? metadata.version;
