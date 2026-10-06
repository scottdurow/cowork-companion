export const APP_RELEASE_VERSION = '1.0.0' as const;
export const APP_NAME = 'Cowork Companion' as const;

export function displayNameFor(version: string) {
  return `${APP_NAME} v${version}`;
}

export function versionStamp(version: string) {
  return `v${version}`;
}

export function versionAccessibleName(version: string) {
  return `${APP_NAME} version ${version}`;
}

export function isSemver(version: string) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version);
}

export const APP_DISPLAY_NAME = displayNameFor(APP_RELEASE_VERSION);
