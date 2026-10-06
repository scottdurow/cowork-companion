import {
  APP_DISPLAY_NAME,
  APP_NAME,
  APP_RELEASE_VERSION,
  isSemver,
  versionAccessibleName,
  versionStamp,
} from '@/lib/app-version';

export interface ReleaseCheckInputs {
  appMetadataDisplayName: string;
  publicationDescription: string;
  sourceText: string;
}

export interface ReleaseCheckResult {
  name: string;
  detail: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function runReleaseChecks(inputs: ReleaseCheckInputs): { passed: number; report: ReleaseCheckResult[] } {
  const report: ReleaseCheckResult[] = [];
  const pass = (name: string, detail: string) => report.push({ name, detail });

  assert(isSemver(APP_RELEASE_VERSION), `Managed-app release version is not semantic: ${APP_RELEASE_VERSION}`);
  pass('semantic release version', APP_RELEASE_VERSION);

  assert(inputs.appMetadataDisplayName === APP_DISPLAY_NAME, `App metadata drifted: expected "${APP_DISPLAY_NAME}", received "${inputs.appMetadataDisplayName}"`);
  assert(inputs.publicationDescription.includes(APP_DISPLAY_NAME), `Publication description does not include "${APP_DISPLAY_NAME}"`);
  pass('publication metadata agrees', APP_DISPLAY_NAME);

  const escapedVersion = APP_RELEASE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literalMatches = inputs.sourceText.match(new RegExp(`\\b${escapedVersion}\\b`, 'g')) ?? [];
  assert(literalMatches.length === 1, `Expected one canonical release-version literal, found ${literalMatches.length}`);
  pass('single release literal', 'Only app-version.ts owns the managed-app release literal');

  assert(inputs.sourceText.includes('data-app-version={APP_RELEASE_VERSION}'), 'Rendered version marker is missing');
  assert(inputs.sourceText.includes('data-app-release={APP_DISPLAY_NAME}'), 'Rendered release marker is missing');
  assert(inputs.sourceText.includes('versionStamp(APP_RELEASE_VERSION)'), `Rendered source does not expose ${versionStamp(APP_RELEASE_VERSION)}`);
  assert(inputs.sourceText.includes('versionAccessibleName(APP_RELEASE_VERSION)'), `Rendered source does not expose the ${APP_NAME} accessible version label`);
  pass('runtime stamp is wired', `${versionStamp(APP_RELEASE_VERSION)} / ${versionAccessibleName(APP_RELEASE_VERSION)}`);

  return { passed: report.length, report };
}
