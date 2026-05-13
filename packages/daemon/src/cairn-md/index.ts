export {
  PROFILE_VERSION,
  emptyProfile,
  scanCairnMd,
  loadProfile,
  matchKnownAnswer,
  matchBucket,
  splitSections,
  normalizeSectionKey,
  extractBullets,
  classifyAuthorityBullet,
  classifyIsBullet,
  parseKnownAnswers,
  extractProjectName,
  extractGoal,
  extractWholeSentence,
  findSectionBody,
  profileCacheKey,
  resolveCairnMdPath,
} from './scanner.js';

export type { Profile, ProfileAuthority, KnownAnswer, AuthorityBucket, IsBucket } from './scanner.js';
