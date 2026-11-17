const pkg = require('./package.json');
const repository = process.env.GITHUB_REPOSITORY || 'BomBilka1/webinar-recorder';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GITHUB_REPOSITORY');
const [owner,repo] = repository.split('/');
module.exports = {
  appId:'com.bombilka.webinarrecorder',
  productName:'Webinar Recorder',
  executableName:'WebinarRecorder',
  directories:{output:'release'},
  files:['desktop/**/*','package.json'],
  extraMetadata:{repository:{type:'git',url:`https://github.com/${repository}.git`}},
  extraFiles:[{from:'USER_GUIDE.txt',to:'READ-ME.txt'}],
  asar:true,
  electronVersion:pkg.devDependencies.electron,
  electronUpdaterCompatibility:'>=6.8.11',
  publish:[{provider:'github',owner,repo,releaseType:'release'}],
  win:{target:[{target:'nsis',arch:['x64']}],
    artifactName:'WebinarRecorder-Setup-${version}-${arch}.${ext}'},
  nsis:{oneClick:false,perMachine:false,allowElevation:false,
    allowToChangeInstallationDirectory:true,createDesktopShortcut:true,
    shortcutName:'Запись вебинара',deleteAppDataOnUninstall:false,
    installerLanguages:['ru_RU','en_US'],displayLanguageSelector:true,
    differentialPackage:true}
};
