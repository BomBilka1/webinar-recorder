// Publish only after every asset is uploaded to a draft. Running clients must
// never see a release containing only a manifest or only an installer.
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {version} = require('../package.json');
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Missing GITHUB_REPOSITORY');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Stable releases need a stable semver version');
const tag = `v${version}`;
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag)
  throw new Error('Git tag must match package.json version');
const assets = [`WebinarRecorder-Setup-${version}-x64.exe`,
  `WebinarRecorder-Setup-${version}-x64.exe.blockmap`,'latest.yml']
  .map(file => path.join('release',file));
assets.forEach(file => {if (!fs.existsSync(file)) throw new Error(`Missing release asset: ${file}`);});
const gh = args => execFileSync('gh',[...args,'--repo',repository],{encoding:'utf8'});
let existing;
try {existing = JSON.parse(gh(['release','view',tag,'--json','isDraft,url']));} catch {}
if (existing && !existing.isDraft) {
  console.log(`Release ${tag} is already published; no assets were replaced.`);
  process.exit(0);
}
let makeLatest = true;
try {
  const releases = JSON.parse(gh(['release','list','--limit','100','--json','tagName,isDraft,isPrerelease']));
  const tuple = text => text.replace(/^v/,'').split('.').map(Number);
  const newer = text => {
    const other=tuple(text),current=tuple(version);
    for(let i=0;i<3;i++) {if(other[i]!==current[i]) return other[i]>current[i];}
    return false;
  };
  makeLatest = !releases.some(release => !release.isDraft && !release.isPrerelease &&
    /^v?\d+\.\d+\.\d+$/.test(release.tagName) && newer(release.tagName));
} catch {throw new Error('Cannot inspect existing releases; publication cancelled');}
if (!existing) gh(['release','create',tag,'--draft','--target',process.env.GITHUB_SHA || 'main',
  '--title',`Webinar Recorder ${version}`,'--generate-notes']);
gh(['release','upload',tag,...assets,'--clobber']);
gh(['release','edit',tag,'--draft=false',`--latest=${makeLatest}`]);
console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
